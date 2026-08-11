import fs from "fs";
import path from "path";
import readline from "readline";
import { once } from "events";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _tmpSuffix() {
  return `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
}

// ─── WalDBFast ────────────────────────────────────────────────────────────────

class WalDBFast {
  /**
   * @param {object} options
   * @param {string}  [options.dir='./data']
   * @param {string}  [options.snapshotFile]
   * @param {string}  [options.journalFile]
   * @param {string}  [options.metaFile]
   * @param {string}  [options.hotFile]
   * @param {number}  [options.journalMaxEntries=50000]
   * @param {number}  [options.compactIntervalMs=30000]
   * @param {number}  [options.maxCachedSessions=200]   — O1: LRU limit
   * @param {boolean} [options.pretty=false]
   * @param {boolean} [options.durable=false]
   */
  constructor(options = {}) {
    this.dir = options.dir
      ? String(options.dir)
      : path.join(process.cwd(), "data");
    this.snapshotFile = options.snapshotFile || "snapshot.json";
    this.journalFile = options.journalFile || "journal.log";
    this.metaFile = options.metaFile || "meta.json";
    this.hotFile = options.hotFile || "hot.json";
    this.journalMaxEntries =
      typeof options.journalMaxEntries === "number"
        ? options.journalMaxEntries
        : 50_000;
    this.compactIntervalMs =
      typeof options.compactIntervalMs === "number"
        ? options.compactIntervalMs
        : 30_000;
    this.maxCachedSessions =
      typeof options.maxCachedSessions === "number"
        ? options.maxCachedSessions
        : 200;
    this.pretty = !!options.pretty;
    this.durable = !!options.durable;

    // ── in-memory stores ───────────────────────────────────────────────────────
    this.cache = new Map(); // Map<sid, Map<key, value>>
    this._lruOrder = []; // O1: LRU tracking array (sid strings)
    this.hotIndex = new Map(); // Map<sid, { key: value, ... }> — critical flags
    this.blocked = new Set();

    // ── internals ──────────────────────────────────────────────────────────────
    this._journalEntries = 0;
    this._journalBytes = 0;
    this._journalStream = null;
    this._initPromise = null;
    this._compacting = false;
    this._compactLock = Promise.resolve();
    this._writeQueue = [];
    this._closing = false;
    this._closed = false;
    this._pendingRestores = new Map();
    this._hotPersistTimer = null;
    this._hotDirty = false;
    this._metaPersistChain = Promise.resolve();
    this._hotPersistChain = Promise.resolve();

    // O3: snapshot parse cache (avoid re-parsing large snapshot on every restore)
    this._snapshotCache = null; // parsed JSON object
    this._snapshotCacheAt = 0; // timestamp of last parse
    this._SNAPSHOT_TTL_MS = 30_000; // 30s TTL

    // Stats counters (O10)
    this._stats = {
      gets: 0,
      sets: 0,
      dels: 0,
      cacheHits: 0,
      cacheMisses: 0,
      restores: 0,
      compactions: 0,
      evictions: 0,
    };

    this._initPromise = this._ensureDirAndInit();
  }

  // ─── Init ──────────────────────────────────────────────────────────────────

  async _ensureDirAndInit() {
    await fs.promises.mkdir(this.dir, { recursive: true }).catch(() => {});

    this.snapshotPath = path.join(this.dir, this.snapshotFile);
    this.journalPath = path.join(this.dir, this.journalFile);
    this.metaPath = path.join(this.dir, this.metaFile);
    this.hotPath = path.join(this.dir, this.hotFile);

    try {
      await this._loadMeta();
      await this._loadHotIndex();
      await this._loadSnapshotAndReplay();
      await this._openJournalStream();
      if (this.compactIntervalMs > 0) this._startPeriodicCompaction();
    } catch (err) {
      console.error("[WalDBFast] init error", err);
      throw err;
    }
  }

  ready() {
    return this._initPromise;
  }

  // ─── Meta ──────────────────────────────────────────────────────────────────

  async _loadMeta() {
    try {
      const raw = await fs.promises
        .readFile(this.metaPath, "utf8")
        .catch(() => null);
      this.blocked = raw
        ? new Set((JSON.parse(raw).blocked || []).map(String))
        : new Set();
    } catch (e) {
      console.warn("[WalDBFast] meta read failed", e);
      this.blocked = new Set();
    }
  }

  _persistMeta() {
    const job = async () => {
      const tmp = `${this.metaPath}.tmp.${_tmpSuffix()}`;
      const data = JSON.stringify(
        { blocked: Array.from(this.blocked) },
        null,
        this.pretty ? 2 : 0
      );
      await fs.promises.writeFile(tmp, data, "utf8");
      if (this.durable) {
        const fd = await fs.promises.open(tmp, "r");
        try {
          await fd.sync();
        } finally {
          await fd.close();
        }
      }
      await fs.promises.rename(tmp, this.metaPath);
    };
    this._metaPersistChain = this._metaPersistChain
      .then(job)
      .catch((e) => console.error("[WalDBFast] meta persist failed", e));
    return this._metaPersistChain;
  }

  // ─── Hot index ─────────────────────────────────────────────────────────────

  async _loadHotIndex() {
    try {
      const raw = await fs.promises
        .readFile(this.hotPath, "utf8")
        .catch(() => null);
      if (raw) {
        for (const [sid, kv] of Object.entries(JSON.parse(raw) || {})) {
          this.hotIndex.set(
            String(sid),
            Object.assign(Object.create(null), kv)
          );
        }
      }
    } catch (e) {
      console.warn("[WalDBFast] hot index load failed", e);
      this.hotIndex = new Map();
    }
  }

  _scheduleHotPersist(delay = 500) {
    this._hotDirty = true;
    if (this._hotPersistTimer) clearTimeout(this._hotPersistTimer);
    this._hotPersistTimer = setTimeout(() => {
      this._hotPersistTimer = null;
      this._persistHotIndex();
    }, delay);
    if (this._hotPersistTimer?.unref) this._hotPersistTimer.unref();
  }

  _persistHotIndex() {
    if (!this._hotDirty) return Promise.resolve();
    const job = async () => {
      const tmp = `${this.hotPath}.tmp.${_tmpSuffix()}`;
      const obj = Object.create(null);
      for (const [sid, kv] of this.hotIndex.entries()) obj[sid] = kv;
      const data = JSON.stringify(obj, null, this.pretty ? 2 : 0);
      await fs.promises.writeFile(tmp, data, "utf8");
      if (this.durable) {
        const fd = await fs.promises.open(tmp, "r");
        try {
          await fd.sync();
        } finally {
          await fd.close();
        }
      }
      await fs.promises.rename(tmp, this.hotPath);
      this._hotDirty = false;
    };
    this._hotPersistChain = this._hotPersistChain
      .then(job)
      .catch((e) => console.error("[WalDBFast] hot persist error", e));
    return this._hotPersistChain;
  }

  // ─── Snapshot + journal load ────────────────────────────────────────────────

  async _loadSnapshotAndReplay() {
    try {
      const raw = await fs.promises
        .readFile(this.snapshotPath, "utf8")
        .catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw);
        // O3: prime snapshot cache on startup
        this._snapshotCache = parsed;
        this._snapshotCacheAt = Date.now();

        for (const [sid, kv] of Object.entries(parsed || {})) {
          if (this.blocked.has(String(sid))) continue;
          const m = new Map();
          for (const [k, v] of Object.entries(kv || {})) m.set(k, v);
          this.cache.set(String(sid), m);
        }
        this._lruOrder = Array.from(this.cache.keys());
        while (this.cache.size > this.maxCachedSessions) {
          const evictSid = this._lruOrder.shift();
          if (!evictSid) break;
          this.cache.delete(evictSid);
          this._stats.evictions++;
        }
      }
    } catch (e) {
      console.warn("[WalDBFast] snapshot load failed", e);
    }

    // Rebuild LRU order from loaded sessions
    this._lruOrder = Array.from(this.cache.keys());

    try {
      const stat = await fs.promises.stat(this.journalPath).catch(() => null);
      if (!stat || stat.size === 0) {
        this._journalEntries = 0;
        this._journalBytes = 0;
        return;
      }

      const rl = readline.createInterface({
        input: fs.createReadStream(this.journalPath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });

      let entries = 0;
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const op = JSON.parse(line);
          entries++;
          if (!this.blocked.has(String(op.sid))) this._applyOpToCache(op);
        } catch {
          /* skip malformed */
        }
      }

      this._journalEntries = entries;
      this._journalBytes = stat.size;
    } catch (e) {
      console.warn("[WalDBFast] journal replay failed", e);
    }
  }

  // ─── Journal stream ────────────────────────────────────────────────────────

  async _openJournalStream() {
    this._journalStream = fs.createWriteStream(this.journalPath, {
      flags: "a",
    });
    this._journalStream.on("error", (e) =>
      console.error("[WalDBFast] journal stream error", e)
    );
    if (!this._journalStream.writable) {
      await once(this._journalStream, "open").catch(() => {});
    }
  }

  _appendJournal(op) {
    if (this._closed) return Promise.resolve();
    if (this._compacting || this._closing) {
      return new Promise((resolve, reject) => {
        this._writeQueue.push({ op, resolve, reject });
      });
    }
    return this._writeToJournal(op);
  }

  _writeToJournal(op) {
    const line = JSON.stringify(op) + "\n";
    const ok = this._journalStream.write(line);
    this._journalBytes += Buffer.byteLength(line);
    this._journalEntries += 1;
    if (ok) return Promise.resolve();
    return once(this._journalStream, "drain").then(() => {});
  }

  // ─── Core cache apply ──────────────────────────────────────────────────────

  _applyOpToCache(op) {
    const sid = String(op.sid);
    if (op.op === "set") {
      let m = this.cache.get(sid);
      if (!m) {
        m = new Map();
        this.cache.set(sid, m);
      }
      m.set(String(op.key), op.value);
    } else if (op.op === "del") {
      const m = this.cache.get(sid);
      if (m) {
        m.delete(String(op.key));
        if (m.size === 0) this.cache.delete(sid);
      }
    } else if (op.op === "set_many") {
      // O9: batch set
      let m = this.cache.get(sid);
      if (!m) {
        m = new Map();
        this.cache.set(sid, m);
      }
      for (const [k, v] of Object.entries(op.kv)) m.set(k, v);
    } else if (op.op === "clear_session") {
      this.cache.delete(sid);
    }
  }

  // ─── O1: LRU cache eviction ────────────────────────────────────────────────

  _lruTouch(sid) {
    // Move sid to end of LRU order (most recently used)
    const idx = this._lruOrder.indexOf(sid);
    if (idx !== -1) this._lruOrder.splice(idx, 1);
    this._lruOrder.push(sid);
  }

  _lruEvictIfNeeded() {
    while (this.cache.size > this.maxCachedSessions) {
      const evictSid = this._lruOrder.shift(); // oldest
      if (!evictSid) break;
      if (this.cache.has(evictSid)) {
        // Before evicting, make sure snapshot is up-to-date (compact handles this)
        this.cache.delete(evictSid);
        this._stats.evictions++;
      }
    }
  }

  // ─── Public read API ──────────────────────────────────────────────────────

  /**
   * Synchronous fast read. O(1) Map lookup.
   */
  get(sessionId, key, defaultValue = undefined) {
    this._stats.gets++;
    const sid = String(sessionId);
    const k = String(key);

    const s = this.cache.get(sid);
    if (s) {
      if (s.has(k)) {
        this._stats.cacheHits++;
        return s.get(k);
      }
    }

    const hot = this.hotIndex.get(sid);
    if (hot && Object.prototype.hasOwnProperty.call(hot, k)) {
      this._stats.cacheHits++;
      return hot[k];
    }

    this._stats.cacheMisses++;
    // Background restore — non-blocking
    this._ensureSessionRestoredBg(sid).catch((e) =>
      console.error("[WalDBFast] bg restore failed", e)
    );
    return defaultValue;
  }

  /**
   * O8: Batch synchronous read — get multiple keys at once.
   * Returns object { key: value, ... } — missing keys use defaultValue.
   *
   * Usage: const { autoread, mode } = db.getMany(sid, ['autoread','mode'], false)
   */
  getMany(sessionId, keys, defaultValue = undefined) {
    const sid = String(sessionId);
    const s = this.cache.get(sid);
    const hot = this.hotIndex.get(sid);
    const out = Object.create(null);

    for (const key of keys) {
      const k = String(key);
      if (s && s.has(k)) {
        out[k] = s.get(k);
        continue;
      }
      if (hot && Object.prototype.hasOwnProperty.call(hot, k)) {
        out[k] = hot[k];
        continue;
      }
      out[k] = defaultValue;
    }

    // Trigger background restore if session not cached
    if (!s) this._ensureSessionRestoredBg(sid).catch(() => {});
    return out;
  }

  /**
   * Async read — guarantees session restored from disk.
   */
  async getAsync(sessionId, key, defaultValue = undefined) {
    const sid = String(sessionId);
    const k = String(key);
    await this._ensureSessionRestored(sid);
    const s = this.cache.get(sid);
    if (s && s.has(k)) return s.get(k);
    const hot = this.hotIndex.get(sid);
    if (hot && Object.prototype.hasOwnProperty.call(hot, k)) return hot[k];
    return defaultValue;
  }

  // ─── Public write API ──────────────────────────────────────────────────────

  async set(sessionId, key, value) {
    this._stats.sets++;
    const sid = String(sessionId);
    const k = String(key);
    await this._ensureSessionRestored(sid);
    const op = { op: "set", sid, key: k, value };
    this._applyOpToCache(op);
    this._lruTouch(sid);
    this._lruEvictIfNeeded();
    await this._appendJournal(op);
    this._maybeCompact().catch((e) =>
      console.error("[WalDBFast] compact error", e)
    );
  }

  async del(sessionId, key) {
    this._stats.dels++;
    const sid = String(sessionId);
    const k = String(key);
    await this._ensureSessionRestored(sid);
    const op = { op: "del", sid, key: k };
    this._applyOpToCache(op);
    await this._appendJournal(op);
    this._maybeCompact().catch((e) =>
      console.error("[WalDBFast] compact error", e)
    );
  }

  /**
   * O9: Batch set — write multiple keys for one session as one journal entry.
   * Faster than calling set() N times under burst writes.
   */
  async setMany(sessionId, kvObj) {
    const sid = String(sessionId);
    await this._ensureSessionRestored(sid);

    // Apply all to cache
    let m = this.cache.get(sid);
    if (!m) {
      m = new Map();
      this.cache.set(sid, m);
    }
    for (const [key, value] of Object.entries(kvObj)) m.set(String(key), value);

    this._lruTouch(sid);
    this._lruEvictIfNeeded();

    // Single journal entry for all keys
    const op = { op: "set_many", sid, kv: kvObj };
    await this._appendJournal(op);
    this._maybeCompact().catch((e) =>
      console.error("[WalDBFast] compact error", e)
    );
  }

  /**
   * Synchronous hot-key set — critical flags (login, autoread, etc).
   */
  setHot(sessionId, key, value) {
    const sid = String(sessionId);
    const k = String(key);

    const obj = this.hotIndex.get(sid) || Object.create(null);
    obj[k] = value;
    this.hotIndex.set(sid, obj);
    this._scheduleHotPersist();

    let m = this.cache.get(sid);
    if (!m) {
      m = new Map();
      this.cache.set(sid, m);
    }
    m.set(k, value);

    const op = { op: "set", sid, key: k, value };
    this._appendJournal(op).catch((e) =>
      console.error("[WalDBFast] setHot journal failed", e)
    );
  }

  delHot(sessionId, key) {
    const sid = String(sessionId);
    const k = String(key);

    const obj = this.hotIndex.get(sid);
    if (obj) {
      delete obj[k];
      if (Object.keys(obj).length === 0) this.hotIndex.delete(sid);
      else this.hotIndex.set(sid, obj);
      this._scheduleHotPersist();
    }

    const m = this.cache.get(sid);
    if (m) {
      m.delete(k);
      if (m.size === 0) this.cache.delete(sid);
    }

    const op = { op: "del", sid, key: k };
    this._appendJournal(op).catch((e) =>
      console.error("[WalDBFast] delHot journal failed", e)
    );
  }

  clearSession(sessionId) {
    const sid = String(sessionId);
    this.cache.delete(sid);
    this.hotIndex.delete(sid);
    this._scheduleHotPersist();
    const op = { op: "clear_session", sid };
    this._appendJournal(op).catch((e) =>
      console.error("[WalDBFast] clearSession journal failed", e)
    );
  }

  /**
   * O6: Logout — evict, block, clear hotIndex.
   */
  async logout(sessionId) {
    const sid = String(sessionId);
    this.cache.delete(sid);
    this.hotIndex.delete(sid);
    this._scheduleHotPersist();

    if (this.blocked.has(sid)) {
      return;
    }

    // Clear from LRU
    const idx = this._lruOrder.indexOf(sid);
    if (idx !== -1) this._lruOrder.splice(idx, 1);
  }

  // ─── Session restore ───────────────────────────────────────────────────────

  async _ensureSessionRestored(sid) {
    if (this.cache.has(sid)) {
      this._lruTouch(sid);
      return;
    }
    if (this._pendingRestores.has(sid)) return this._pendingRestores.get(sid);

    if (this.blocked.has(sid)) {
      return;
    }

    const p = this._restoreSessionFromDisk(sid)
      .catch((e) => console.error("[WalDBFast] restore error", sid, e))
      .finally(() => this._pendingRestores.delete(sid));

    this._pendingRestores.set(sid, p);
    return p;
  }

  _ensureSessionRestoredBg(sid) {
    if (this.cache.has(sid)) {
      this._lruTouch(sid);
      return Promise.resolve();
    }
    if (this._pendingRestores.has(sid)) return this._pendingRestores.get(sid);

    if (this.blocked.has(sid)) {
      this.blocked.delete(sid);
      this._persistMeta().catch((e) =>
        console.warn("[WalDBFast] async persist meta failed", e)
      );
    }

    const p = this._restoreSessionFromDisk(sid)
      .catch((e) => console.error("[WalDBFast] restore error", sid, e))
      .finally(() => this._pendingRestores.delete(sid));

    this._pendingRestores.set(sid, p);
    return p;
  }

  /**
   * O3: Use cached snapshot parse (30s TTL) — avoid re-reading + re-parsing
   * the entire snapshot file for every session restore.
   */
  async _getSnapshotParsed() {
    const now = Date.now();
    if (
      this._snapshotCache &&
      now - this._snapshotCacheAt < this._SNAPSHOT_TTL_MS
    ) {
      return this._snapshotCache;
    }
    try {
      const raw = await fs.promises
        .readFile(this.snapshotPath, "utf8")
        .catch(() => null);
      this._snapshotCache = raw ? JSON.parse(raw) : Object.create(null);
      this._snapshotCacheAt = Date.now();
    } catch {
      this._snapshotCache = Object.create(null);
    }
    return this._snapshotCache;
  }

  async _restoreSessionFromDisk(sid) {
    this._stats.restores++;
    const m = new Map();

    // O3: use cached snapshot
    try {
      const parsed = await this._getSnapshotParsed();
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, sid)) {
        const base = parsed[sid];
        if (base && typeof base === "object") {
          for (const [k, v] of Object.entries(base)) m.set(k, v);
        }
      }
    } catch (e) {
      console.warn("[WalDBFast] snapshot read during restore failed", e);
    }

    // Replay journal entries for this sid only
    try {
      const stat = await fs.promises.stat(this.journalPath).catch(() => null);
      if (stat && stat.size > 0) {
        const rl = readline.createInterface({
          input: fs.createReadStream(this.journalPath, { encoding: "utf8" }),
          crlfDelay: Infinity,
        });
        for await (const line of rl) {
          if (!line.trim()) continue;
          if (!line.includes(`"${sid}"`)) continue;
          try {
            const op = JSON.parse(line);
            if (String(op.sid) !== sid) continue;
            if (op.op === "set") m.set(String(op.key), op.value);
            else if (op.op === "del") m.delete(String(op.key));
            else if (op.op === "set_many") {
              for (const [k, v] of Object.entries(op.kv)) m.set(k, v);
            } else if (op.op === "clear_session") m.clear();
          } catch {
            /* skip malformed */
          }
        }
      }
    } catch (e) {
      console.warn("[WalDBFast] journal read during restore failed", e);
    }

    // Apply in-memory queued ops (written during compaction)
    for (const item of this._writeQueue) {
      if (String(item.op.sid) !== sid) continue;
      const op = item.op;
      if (op.op === "set") m.set(String(op.key), op.value);
      else if (op.op === "del") m.delete(String(op.key));
      else if (op.op === "set_many") {
        for (const [k, v] of Object.entries(op.kv)) m.set(k, v);
      } else if (op.op === "clear_session") m.clear();
    }

    this.cache.set(sid, m);
    this._lruTouch(sid);
    this._lruEvictIfNeeded();
  }

  // ─── Compaction ────────────────────────────────────────────────────────────

  async _maybeCompact() {
    if (this._compacting) return;
    if (this._journalEntries >= this.journalMaxEntries) await this._compact();
  }

  _startPeriodicCompaction() {
    this._compactTimer = setInterval(() => {
      if (this._journalEntries > 0) {
        this._compact().catch((e) =>
          console.error("[WalDBFast] compact failed", e)
        );
      }
    }, this.compactIntervalMs);
    if (this._compactTimer?.unref) this._compactTimer.unref();
  }

  async _compact() {
    this._compactLock = this._compactLock.then(() => this._doCompact());
    return this._compactLock;
  }

  async _doCompact() {
    if (this._compacting) return;
    this._compacting = true;
    this._stats.compactions++;

    try {
      if (this._journalStream) {
        await new Promise((resolve, reject) => {
          this._journalStream.once("error", reject);
          this._journalStream.end(() => resolve());
        }).catch((e) =>
          console.warn("[WalDBFast] error closing journal stream", e)
        );
        this._journalStream = null;
      }

      // Merge snapshot + cache
      let existingSnapshot = Object.create(null);
      try {
        const raw = await fs.promises
          .readFile(this.snapshotPath, "utf8")
          .catch(() => null);
        if (raw) existingSnapshot = JSON.parse(raw) || Object.create(null);
      } catch {
        /* start with empty */
      }

      const merged = Object.assign(Object.create(null), existingSnapshot);
      for (const [sid, map] of this.cache.entries()) {
        const obj = Object.create(null);
        for (const [k, v] of map.entries()) obj[k] = v;
        merged[sid] = obj;
      }
      for (const sid of this.blocked) delete merged[sid];

      // Invalidate snapshot cache after compact
      this._snapshotCache = merged;
      this._snapshotCacheAt = Date.now();

      const snapshotTmp = `${this.snapshotPath}.tmp.${_tmpSuffix()}`;
      const data = JSON.stringify(merged, null, this.pretty ? 2 : 0);
      try {
        await fs.promises.writeFile(snapshotTmp, data, "utf8");
        if (this.durable) {
          const fd = await fs.promises.open(snapshotTmp, "r");
          try {
            await fd.sync();
          } finally {
            await fd.close();
          }
        }
        await fs.promises.rename(snapshotTmp, this.snapshotPath);
      } catch (e) {
        console.error("[WalDBFast] snapshot write failed", e);
        try {
          await fs.promises.unlink(snapshotTmp).catch(() => {});
        } catch {}
      }

      try {
        await fs.promises.writeFile(this.journalPath, "", "utf8");
      } catch (e) {
        console.error("[WalDBFast] journal truncate failed", e);
      }

      this._journalEntries = 0;
      this._journalBytes = 0;
      await this._openJournalStream();

      const queue = this._writeQueue;
      this._writeQueue = [];
      for (const item of queue) {
        try {
          this._applyOpToCache(item.op);
          await this._writeToJournal(item.op);
          item.resolve();
        } catch (e) {
          item.reject(e);
        }
      }
    } finally {
      this._compacting = false;
    }
  }

  // ─── Flush & close ─────────────────────────────────────────────────────────

  async flush() {
    if (this._closed) return;
    if (
      this._journalStream &&
      !this._journalStream.writable &&
      !this._journalStream.destroyed
    ) {
      await once(this._journalStream, "finish").catch(() => {});
    }
    await this._compact();
    await this._persistHotIndex();
    await this._persistMeta();
  }

  async close() {
    if (this._closed) return;
    this._closing = true;

    if (this._compactTimer) clearInterval(this._compactTimer);
    if (this._hotPersistTimer) {
      clearTimeout(this._hotPersistTimer);
      this._hotPersistTimer = null;
    }

    try {
      await this.flush();
    } catch (e) {
      console.warn("[WalDBFast] flush failed on close", e);
    }

    if (this._writeQueue.length > 0) {
      const queue = this._writeQueue;
      this._writeQueue = [];
      for (const item of queue) {
        try {
          this._applyOpToCache(item.op);
          if (this._journalStream?.writable)
            await this._writeToJournal(item.op);
          item.resolve();
        } catch (e) {
          item.reject(e);
        }
      }
    }

    try {
      if (this._journalStream) {
        await new Promise((resolve) => {
          this._journalStream.end(() => resolve());
        }).catch(() => {});
        this._journalStream = null;
      }
    } catch {
      /* ignore */
    }

    this._closed = true;
  }

  // ─── O10: Health stats ─────────────────────────────────────────────────────

  /**
   * Returns runtime statistics. Useful for /health or /status endpoint.
   */
  stats() {
    return {
      ...this._stats,
      cachedSessions: this.cache.size,
      hotIndexSize: this.hotIndex.size,
      blockedSessions: this.blocked.size,
      pendingRestores: this._pendingRestores.size,
      journalEntries: this._journalEntries,
      journalBytes: this._journalBytes,
      writeQueueLen: this._writeQueue.length,
      compacting: this._compacting,
      closed: this._closed,
      cacheHitRate:
        this._stats.gets > 0
          ? ((this._stats.cacheHits / this._stats.gets) * 100).toFixed(1) + "%"
          : "n/a",
    };
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  isBlocked(sessionId) {
    return this.blocked.has(String(sessionId));
  }
  isClosed() {
    return this._closed;
  }

  export() {
    const out = Object.create(null);
    for (const [sid, map] of this.cache.entries()) {
      out[sid] = Object.create(null);
      for (const [k, v] of map.entries()) out[sid][k] = v;
    }
    return out;
  }

  exportSession(sessionId) {
    const sid = String(sessionId);
    const out = Object.create(null);
    const m = this.cache.get(sid);
    if (m) for (const [k, v] of m.entries()) out[k] = v;
    return out;
  }

  sessions() {
    const inCache = new Set(this.cache.keys());
    if (this._snapshotCache) {
      for (const sid of Object.keys(this._snapshotCache)) {
        if (!this.blocked.has(sid)) inCache.add(sid);
      }
    }
    return Array.from(inCache);
  }
}

export default WalDBFast;
