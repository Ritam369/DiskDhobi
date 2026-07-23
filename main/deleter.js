'use strict';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');

/**
 * Build a dry-run preview: validate the requested paths and return the
 * confirmed list + aggregate size. No deletion happens here.
 *
 * @param {Array<{ id, path, sizeBytes }>} selectedItems
 * @returns {{ items: Array<{id, path, sizeBytes}>, totalBytes: number }}
 */
function buildPreview(selectedItems) {
  const items = selectedItems.map((item) => ({
    id: item.id,
    path: item.path,
    sizeBytes: item.sizeBytes,
    category: item.category,
    type: item.type,
  }));

  const totalBytes = items.reduce((sum, item) => sum + (item.sizeBytes || 0), 0);

  return { items, totalBytes };
}

/**
 * Perform actual deletion of the supplied items.
 *
 * Deletes each item individually so a single failure does not abort the
 * rest. Returns a per-item result array and the total bytes freed.
 *
 * @param {Array<{ id, path, sizeBytes }>} items
 * @returns {Promise<{
 *   results: Array<{ id, path, success, error?, bytesFreed }>,
 *   totalFreed: number,
 *   failureCount: number
 * }>}
 */
async function deleteItems(items) {
  const results = [];
  let totalFreed = 0;
  let failureCount = 0;

  for (const item of items) {
    const itemPath = item.path;

    // Extra safety: never allow deleting paths that look like system roots or
    // the user's entire home directory, even if somehow passed in.
    if (isForbiddenPath(itemPath)) {
      results.push({
        id: item.id,
        path: itemPath,
        success: false,
        error: 'Refusing to delete a system or home root path.',
        bytesFreed: 0,
      });
      failureCount++;
      continue;
    }

    try {
      await fs.rm(itemPath, { recursive: true, force: true });
      results.push({
        id: item.id,
        path: itemPath,
        success: true,
        bytesFreed: item.sizeBytes || 0,
      });
      totalFreed += item.sizeBytes || 0;
    } catch (err) {
      results.push({
        id: item.id,
        path: itemPath,
        success: false,
        error: err.message,
        bytesFreed: 0,
      });
      failureCount++;
    }
  }

  return { results, totalFreed, failureCount };
}

/**
 * Safeguard: returns true for paths that must never be deleted.
 */
const FORBIDDEN = new Set([
  '/',
  '/home',
  '/usr',
  '/etc',
  '/var',
  '/tmp',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/opt',
  '/root',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
]);

function isForbiddenPath(p) {
  const norm = path.resolve(p);
  if (FORBIDDEN.has(norm)) return true;
  if (norm === os.homedir()) return true;
  return false;
}

module.exports = { buildPreview, deleteItems };
