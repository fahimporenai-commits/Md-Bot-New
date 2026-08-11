import fs from "fs-extra";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Internal registries ────────────────────────────────────────────────────────
const commandMap = new Map(); // command string → plugin
const textPlugins = []; // plugins with on === "text"
const msgPlugins = []; // plugins with on === "message" (all msg types)
const allPlugins = []; // every registered plugin

let _pluginsSnapshot = null;
let _loadingPromise = null;
let _loadedDir = null;

// ── Module decorator ──────────────────────────────────────────────────────────

/**
 * Module(meta)(exec) — register a plugin.
 *
 * meta shape:
 *   command?: string        — registers as a command (e.g. "menu")
 *   aliases?: string[]      — extra command names that map to same exec
 *   on?: "text"|"message"|"group-participants.update"
 *   name?: string           — human-readable name
 *   description?: string    — description shown in .menu
 *   package?: string        — category for grouping
 *
 * on: "text"    → fires only when message has a text body
 * on: "message" → fires for ALL message types (sticker, image, video, etc.)
 * on: "group-participants.update" → fires on join/leave events
 */
export function Module(meta) {
  return (exec) => {
    if (typeof exec !== "function") {
      console.warn(`[plugins] Module registered without exec function:`, meta);
      return;
    }

    const plugin = Object.freeze({ ...meta, exec });

    // Register primary command
    if (plugin.command) {
      if (commandMap.has(plugin.command)) {
        console.warn(
          `[plugins] ⚠️  Duplicate command "${plugin.command}" — overwriting`
        );
      }
      commandMap.set(plugin.command, plugin);
    }

    // Register aliases
    if (Array.isArray(plugin.aliases)) {
      for (const alias of plugin.aliases) {
        if (commandMap.has(alias)) {
          console.warn(
            `[plugins] ⚠️  Duplicate alias "${alias}" — overwriting`
          );
        }
        commandMap.set(alias, plugin);
      }
    }

    // on: "text"    → text body only
    if (plugin.on === "text") textPlugins.push(plugin);

    // on: "message" → all message types (sticker, image, etc.)
    if (plugin.on === "message") msgPlugins.push(plugin);

    allPlugins.push(plugin);
  };
}

// ── Snapshot helper ───────────────────────────────────────────────────────────

function getSnapshot() {
  return {
    commands: new Map(commandMap),
    text: [...textPlugins],
    message: [...msgPlugins],
    all: [...allPlugins],
  };
}

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * loadPlugins(dir) — import every .js file in dir.
 * Each file calls Module(...)(exec) during import side-effects.
 */
export async function loadPlugins(dir = path.join(__dirname, "..", "plugins")) {
  const resolvedDir = path.resolve(dir);

  if (allPlugins.length > 0 && _loadedDir === resolvedDir) {
    _pluginsSnapshot = getSnapshot();
    return _pluginsSnapshot;
  }

  let files = [];
  try {
    const entries = await fs.readdir(resolvedDir);
    files = entries.filter((f) => f.endsWith(".js")).sort();
  } catch (err) {
    console.error(
      "[plugins] Failed to read directory:",
      resolvedDir,
      err?.message || err
    );
    _pluginsSnapshot = getSnapshot();
    return _pluginsSnapshot;
  }

  let loaded = 0;
  let failed = 0;

  for (const file of files) {
    try {
      const filePath = path.join(resolvedDir, file);
      await import(pathToFileURL(filePath).href);
      console.log(`[plugins] ✅ Loaded: ${file}`);
      loaded++;
    } catch (err) {
      console.error(`[plugins] ❌ Error loading ${file}:`, err?.message || err);
      failed++;
    }
  }

  console.log(
    `[plugins] 📦 Commands: ${commandMap.size} | Text: ${textPlugins.length} | Message: ${msgPlugins.length} | Total: ${allPlugins.length}` +
      (failed > 0 ? ` | ⚠️  Failed: ${failed}` : "")
  );

  _loadedDir = resolvedDir;
  _pluginsSnapshot = getSnapshot();
  _loadingPromise = null;
  return _pluginsSnapshot;
}

// ── Hot-path synchronous getter ───────────────────────────────────────────────

/**
 * ensurePlugins() — synchronous snapshot getter for the hot message path.
 * Do NOT await this. Use forceLoadPlugins() at startup instead.
 */
export function ensurePlugins() {
  if (_pluginsSnapshot) return _pluginsSnapshot;

  if (!_loadingPromise) {
    _loadingPromise = loadPlugins().catch((err) => {
      console.error("[plugins] Background load failed:", err?.message || err);
      _loadingPromise = null;
    });
  }

  return {
    commands: new Map(),
    text: [],
    message: [],
    all: [],
  };
}

// ── Startup loader ────────────────────────────────────────────────────────────

/**
 * forceLoadPlugins(dir) — awaitable, use at startup.
 * Blocks until all plugins are loaded.
 */
export async function forceLoadPlugins(dir) {
  if (_pluginsSnapshot && (!dir || path.resolve(dir) === _loadedDir)) {
    return _pluginsSnapshot;
  }
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = loadPlugins(dir);
  return _loadingPromise;
}

// ── Exports ───────────────────────────────────────────────────────────────────

export const commands = commandMap;

export function getCommands() {
  return [...allPlugins];
}

export function getPluginInfo() {
  return {
    commands: Array.from(commandMap.keys()),
    textPlugins: textPlugins.map((p) => p.name || p.on || "unnamed"),
    msgPlugins: msgPlugins.map((p) => p.name || p.on || "unnamed"),
    total: allPlugins.length,
    loadedDir: _loadedDir,
    loaded: _pluginsSnapshot !== null,
  };
}
