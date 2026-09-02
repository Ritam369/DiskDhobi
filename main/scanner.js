'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Load detection config. Resolved relative to the project root so it works
// whether we run from source or from an asar archive.
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'patterns.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    // Fall back to safe defaults if the config file is somehow missing.
    return {
      sizeThresholdBytes: 104857600,
      dependencyFolders: ['node_modules', '.venv', 'venv', 'target', 'vendor'],
      cacheFolders: [
        '.cache', '__pycache__', '.npm', '.pnpm-store',
        'dist', 'build', 'out', '.next/cache', '.yarn/cache',
      ],
      dangerousRoots: ['/', '/home', '/usr', '/etc', '/var', '/tmp'],
    };
  }
}

/**
 * Compute disk usage of a path in bytes using `du -sb`.
 * Returns 0 on error (e.g. permission denied on a subdir).
 */
function duBytes(targetPath) {
  return new Promise((resolve) => {
    execFile('du', ['-sb', '--', targetPath], (err, stdout) => {
      if (err) {
        resolve(0);
        return;
      }
      const match = stdout.match(/^(\d+)/);
      resolve(match ? parseInt(match[1], 10) : 0);
    });
  });
}

/**
 * Given a file path, return true if the path (after resolving symlinks)
 * stays inside rootPath. This prevents following symlinks that escape root.
 */
function isInsideRoot(filePath, rootPath) {
  try {
    const realFile = fs.realpathSync(filePath);
    const realRoot = fs.realpathSync(rootPath);
    return realFile === realRoot || realFile.startsWith(realRoot + path.sep);
  } catch {
    // If we cannot resolve, treat as outside root to be safe.
    return false;
  }
}

/**
 * Match a directory name against pattern lists.
 * Returns { matched: true, category } or { matched: false }.
 *
 * Patterns can be plain names ("node_modules") or relative sub-paths
 * (".next/cache"). We test both the bare directory name and a trailing
 * portion of the absolute path to handle sub-path patterns.
 */
function matchDirectory(dirPath, config) {
  const dirName = path.basename(dirPath);

  for (const pattern of config.dependencyFolders) {
    if (dirName === pattern || dirPath.endsWith(path.sep + pattern)) {
      return { matched: true, category: 'dependency' };
    }
  }

  for (const pattern of config.cacheFolders) {
    const normalised = pattern.split('/').join(path.sep);
    if (dirName === normalised || dirPath.endsWith(path.sep + normalised)) {
      return { matched: true, category: 'cache' };
    }
  }

  return { matched: false };
}

/**
 * Primary scan function.
 *
 * @param {string} rootPath   - Absolute path chosen by the user.
 * @param {object} options    - { onProgress(stats), onItem(item), signal }
 *   onProgress is called periodically with { scanned, found, currentPath }
 *   onItem     is called once per detected heavy item
 *   signal     is an object { cancelled: false } — set .cancelled = true to abort
 *
 * @returns {Promise<{ items: Item[], skipped: string[] }>}
 *   items   – array of { id, path, category, sizeBytes, type }
 *   skipped – array of paths we couldn't read (permission denied etc.)
 */
async function scan(rootPath, options = {}) {
  const config = loadConfig();
  const { onProgress = () => {}, onItem = () => {}, signal = { cancelled: false } } = options;

  const items = [];
  const skipped = [];
  let scannedCount = 0;
  let progressTimer = null;
  let lastProgressPath = rootPath;

  // Normalise root for safe comparisons.
  const normRoot = path.resolve(rootPath);

  // Throttled progress emitter so we don't spam IPC.
  function scheduleProgress() {
    if (progressTimer) return;
    progressTimer = setTimeout(() => {
      progressTimer = null;
      onProgress({
        scanned: scannedCount,
        found: items.length,
        currentPath: lastProgressPath,
      });
    }, 150);
  }

  let idCounter = 0;
  function nextId() {
    return `item-${++idCounter}`;
  }

  /**
   * Recursive directory walker.
   * Checks signal.cancelled at each entry so cancellation stops the walk
   * immediately, not just the IPC reporting.
   */
  async function walk(dir) {
    // Stop immediately if cancelled.
    if (signal.cancelled) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: dir, reason: err.message });
      return;
    }

    for (const entry of entries) {
      // Check cancellation at every entry — this is what makes it truly responsive.
      if (signal.cancelled) return;

      const fullPath = path.join(dir, entry.name);
      scannedCount++;
      lastProgressPath = fullPath;
      scheduleProgress();

      // ── Symlink safety ──────────────────────────────────────────────────
      if (entry.isSymbolicLink()) {
        // Only follow if the target stays within root.
        if (!isInsideRoot(fullPath, normRoot)) {
          // Skip symlinks that escape the root entirely.
          continue;
        }
        // If it points inside root, let the real-type check below handle it.
      }

      if (entry.isDirectory() || entry.isSymbolicLink()) {
        // Don't let symlinks that resolve inside root recurse further unless
        // we can confirm the resolved path is a directory.
        let statResult;
        try {
          statResult = fs.statSync(fullPath); // follows symlinks
        } catch {
          skipped.push({ path: fullPath, reason: 'stat failed' });
          continue;
        }

        if (!statResult.isDirectory()) {
          // It's a symlink to a file — check size threshold below.
          const sizeBytes = statResult.size;
          if (sizeBytes >= config.sizeThresholdBytes) {
            const item = {
              id: nextId(),
              path: fullPath,
              category: 'large-file',
              sizeBytes,
              type: 'file',
            };
            items.push(item);
            onItem(item);
          }
          continue;
        }

        // Check if this directory matches a heavy-folder pattern.
        const { matched, category } = matchDirectory(fullPath, config);
        if (matched) {
          // Measure without recursing into it.
          const sizeBytes = await duBytes(fullPath);
          if (signal.cancelled) return; // du may take a moment — re-check after await
          const item = {
            id: nextId(),
            path: fullPath,
            category,
            sizeBytes,
            type: 'directory',
          };
          items.push(item);
          onItem(item);
          // Do NOT recurse — treat entire dir as one unit.
          continue;
        }

        // Ordinary directory — recurse.
        await walk(fullPath);
      } else if (entry.isFile()) {
        // Check large-file threshold.
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size >= config.sizeThresholdBytes) {
            const item = {
              id: nextId(),
              path: fullPath,
              category: 'large-file',
              sizeBytes: stat.size,
              type: 'file',
            };
            items.push(item);
            onItem(item);
          }
        } catch (err) {
          skipped.push({ path: fullPath, reason: err.message });
        }
      }
    }
  }

  // Kick off the walk.
  await walk(normRoot);

  // Fire one final progress update.
  if (progressTimer) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
  onProgress({
    scanned: scannedCount,
    found: items.length,
    currentPath: normRoot,
    done: true,
  });

  return { items, skipped };
}

/**
 * Check whether a root path is "dangerous" (too broad).
 * Blocks both exact matches AND any sub-path that descends from a dangerous root.
 * Returns { dangerous: bool, reason: string | null, matchedRoot: string | null }
 */
function checkDangerousRoot(rootPath) {
  const config = loadConfig();
  const norm = path.resolve(rootPath);

  // Check against every dangerous root — exact match OR descendant.
  for (const dangerRoot of config.dangerousRoots) {
    const normDanger = path.resolve(dangerRoot);

    // Exact match: the selected path IS the dangerous root.
    if (norm === normDanger) {
      return {
        dangerous: true,
        matchedRoot: normDanger,
        reason: `"${norm}" is a protected system path. Scanning here could touch critical files.`,
      };
    }

    // Descendant match: the selected path lives inside a dangerous root.
    // Use path.sep suffix so "/homes/foo" doesn't falsely match "/home".
    if (norm.startsWith(normDanger + path.sep)) {
      return {
        dangerous: true,
        matchedRoot: normDanger,
        reason: `"${norm}" is inside the protected path "${normDanger}". Pick a folder outside protected system directories.`,
      };
    }
  }

  return { dangerous: false, reason: null, matchedRoot: null };
}

module.exports = { scan, checkDangerousRoot, loadConfig };
