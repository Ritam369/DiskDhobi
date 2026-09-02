'use strict';

/**
 * renderer.js — all UI logic for Storage Reclaimer.
 *
 * Communicates with the main process exclusively via window.api (exposed by
 * preload.js through contextBridge). Never accesses Node/Electron directly.
 *
 * State machine:
 *   idle → scanning → results → (delete flow) → result-summary
 *                 ↑__________________________________↑ (scan again)
 */

// ── DOM references ────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const btnPickFolder     = $('btn-pick-folder');
const btnScan           = $('btn-scan');
const scanBtnLabel      = $('scan-btn-label');
const selectedPathEl    = $('selected-path');

const dangerModal       = $('modal-danger');
const dangerModalMsg    = $('danger-modal-message');
const btnDangerReselect = $('btn-danger-reselect');

const progressTrack     = $('progress-bar-track');
const progressFill      = $('progress-bar-fill');
const progressStatus    = $('progress-status');
const progressText      = $('progress-text');
const btnCancelScan     = $('btn-cancel-scan');

const viewIdle          = $('view-idle');
const viewResults       = $('view-results');
const viewResultSummary = $('view-result-summary');

const skippedNotice     = $('skipped-notice');
const skippedText       = $('skipped-text');
const btnShowSkipped    = $('btn-show-skipped');

const filterCategory    = $('filter-category');
const filterSearch      = $('filter-search');
const sortBy            = $('sort-by');
const checkAllHeader    = $('check-all-header');
const resultsTbody      = $('results-tbody');
const noResultsMsg      = $('no-results-msg');

const sumFound          = $('sum-found');
const sumReclaimable    = $('sum-reclaimable');
const sumSelected       = $('sum-selected');
const btnDelete         = $('btn-delete');

const resultIcon        = $('result-icon');
const resultHeadline    = $('result-headline');
const resultSub         = $('result-sub');
const statFreed         = $('stat-freed');
const statDeleted       = $('stat-deleted');
const statFailures      = $('stat-failures');
const failureDetails    = $('failure-details');
const failureList       = $('failure-list');
const btnScanAgain      = $('btn-scan-again');

// Modals
const modalSkipped      = $('modal-skipped');
const skippedModalList  = $('skipped-modal-list');
const modalConfirm      = $('modal-confirm');
const confirmTotalSize  = $('confirm-total-size');
const confirmItemCount  = $('confirm-item-count');
const confirmPathList   = $('confirm-path-list');
const btnCancelConfirm  = $('btn-cancel-confirm');
const btnConfirmDelete  = $('btn-confirm-delete');

// ── Application state ─────────────────────────────────────────────────────
let state = {
  rootPath: null,
  scanning: false,
  allItems: [],         // full scan result (Item[])
  filteredItems: [],    // after filter+sort
  selectedIds: new Set(),
  skippedPaths: [],
  pendingDeleteItems: null, // items staged for dry-run
  unsubscribers: [],    // IPC listener cleanup functions
};

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Format a byte count into a human-readable string.
 * Uses binary prefixes (GiB, MiB, KiB) rounded to 1 decimal place.
 */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

function formatNumber(n) {
  return new Intl.NumberFormat().format(n);
}

function categoryLabel(cat) {
  switch (cat) {
    case 'dependency': return 'Dependency';
    case 'cache':      return 'Cache';
    case 'large-file': return 'Large File';
    default:           return cat;
  }
}

function categoryBadgeClass(cat) {
  switch (cat) {
    case 'dependency': return 'badge-dependency';
    case 'cache':      return 'badge-cache';
    case 'large-file': return 'badge-large-file';
    default:           return '';
  }
}

// ── View switching ────────────────────────────────────────────────────────

function showView(name) {
  viewIdle.classList.add('hidden');
  viewResults.classList.add('hidden');
  viewResultSummary.classList.add('hidden');

  switch (name) {
    case 'idle':    viewIdle.classList.remove('hidden');    break;
    case 'results': viewResults.classList.remove('hidden'); break;
    case 'summary': viewResultSummary.classList.remove('hidden'); break;
  }
}

function setScanning(active) {
  state.scanning = active;
  progressTrack.classList.toggle('hidden', !active);
  progressStatus.classList.toggle('hidden', !active);
  btnScan.disabled = active;
  btnPickFolder.disabled = active;
  scanBtnLabel.textContent = active ? 'Scanning…' : 'Scan';
}

// ── Folder selection ──────────────────────────────────────────────────────

btnPickFolder.addEventListener('click', async () => {
  const result = await window.api.selectFolder();
  if (!result) return; // user cancelled the picker

  if (result.dangerous) {
    // Dangerous path — do NOT commit it to state, show blocking modal.
    // The previously selected (safe) path, if any, remains in state.rootPath.
    btnScan.disabled = !state.rootPath; // keep Scan enabled only if a safe path was already chosen
    selectedPathEl.textContent = result.path;
    selectedPathEl.title = result.path;
    dangerModalMsg.textContent = result.reason;
    openModal(dangerModal);
  } else {
    state.rootPath = result.path;
    selectedPathEl.textContent = result.path;
    selectedPathEl.title = result.path;
    btnScan.disabled = false;
  }
});

// "Select Another Path" inside the danger modal re-opens the folder picker.
btnDangerReselect.addEventListener('click', async () => {
  closeModal(dangerModal);
  // Restore the display to whatever safe path was previously selected (if any).
  selectedPathEl.textContent = state.rootPath || 'No folder selected';
  selectedPathEl.title = state.rootPath || '';
  btnScan.disabled = !state.rootPath;
  // Re-trigger the folder picker immediately so the user can pick a safe path.
  btnPickFolder.click();
});

// ── Scan ──────────────────────────────────────────────────────────────────

btnScan.addEventListener('click', startScan);

async function startScan() {
  if (!state.rootPath || state.scanning) return;

  // Reset
  state.allItems = [];
  state.filteredItems = [];
  state.selectedIds = new Set();
  state.skippedPaths = [];
  state.pendingDeleteItems = null;

  resultsTbody.innerHTML = '';
  skippedNotice.classList.add('hidden');
  updateSummaryBar();
  setScanning(true);
  showView('idle');  // keep idle visible while scanning starts; results appear incrementally

  progressText.textContent = 'Starting scan…';

  // IPC listener cleanup: remove any old listeners first
  state.unsubscribers.forEach((fn) => fn());
  state.unsubscribers = [];

  state.unsubscribers.push(
    window.api.onScanProgress((data) => {
      const msg = data.done
        ? `Scan complete — scanned ${formatNumber(data.scanned)} items, found ${formatNumber(data.found)} heavy items`
        : `Scanned ${formatNumber(data.scanned)} items, found ${formatNumber(data.found)} heavy items so far…`;
      progressText.textContent = msg;
    })
  );

  state.unsubscribers.push(
    window.api.onScanItem((item) => {
      state.allItems.push(item);
      applyFilterSort(); // re-render table incrementally
      if (viewIdle.classList.contains('hidden') === false) {
        showView('results');
      }
    })
  );

  state.unsubscribers.push(
    window.api.onScanComplete((data) => {
      state.skippedPaths = data.skipped || [];
      finishScan();
    })
  );

  state.unsubscribers.push(
    window.api.onScanError((data) => {
      progressText.textContent = `Error: ${data.message}`;
      setScanning(false);
    })
  );

  const scanResult = await window.api.startScan(state.rootPath);

  // Main process blocked the scan (dangerous path that slipped past the modal).
  if (scanResult && scanResult.blocked) {
    setScanning(false);
    dangerModalMsg.textContent = scanResult.reason;
    openModal(dangerModal);
    state.rootPath = null;
    selectedPathEl.textContent = 'No folder selected';
    selectedPathEl.title = '';
  }
}

function finishScan() {
  // Clean up IPC listeners
  state.unsubscribers.forEach((fn) => fn());
  state.unsubscribers = [];

  setScanning(false);

  if (state.allItems.length === 0) {
    showView('idle');
    viewIdle.querySelector('.idle-title').textContent = 'Nothing found';
    viewIdle.querySelector('.idle-sub').textContent =
      'No heavy folders or large files were detected under the selected root.';
  } else {
    applyFilterSort();
    showView('results');
  }

  if (state.skippedPaths.length > 0) {
    skippedText.textContent =
      `${state.skippedPaths.length} path${state.skippedPaths.length !== 1 ? 's' : ''} could not be accessed.`;
    skippedNotice.classList.remove('hidden');
  }

  updateSummaryBar();
}

btnCancelScan.addEventListener('click', async () => {
  await window.api.cancelScan();
  setScanning(false);
  if (state.allItems.length > 0) {
    applyFilterSort();
    showView('results');
  }
});

// ── Filter / sort ─────────────────────────────────────────────────────────

filterCategory.addEventListener('change', applyFilterSort);
filterSearch.addEventListener('input', applyFilterSort);
sortBy.addEventListener('change', applyFilterSort);

function applyFilterSort() {
  const catFilter  = filterCategory.value;
  const textFilter = filterSearch.value.toLowerCase().trim();
  const sortValue  = sortBy.value;

  let filtered = state.allItems.filter((item) => {
    if (catFilter !== 'all' && item.category !== catFilter) return false;
    if (textFilter && !item.path.toLowerCase().includes(textFilter)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    switch (sortValue) {
      case 'size-desc': return b.sizeBytes - a.sizeBytes;
      case 'size-asc':  return a.sizeBytes - b.sizeBytes;
      case 'name-asc':  return a.path.localeCompare(b.path);
      case 'name-desc': return b.path.localeCompare(a.path);
      default:          return b.sizeBytes - a.sizeBytes;
    }
  });

  state.filteredItems = filtered;
  renderTable();
}

// ── Table rendering ───────────────────────────────────────────────────────

function renderTable() {
  const fragment = document.createDocumentFragment();

  if (state.filteredItems.length === 0) {
    resultsTbody.innerHTML = '';
    noResultsMsg.classList.remove('hidden');
    updateHeaderCheckbox();
    return;
  }

  noResultsMsg.classList.add('hidden');

  for (const item of state.filteredItems) {
    const tr = document.createElement('tr');
    const isSelected = state.selectedIds.has(item.id);
    if (isSelected) tr.classList.add('selected-row');

    tr.innerHTML = `
      <td class="col-check">
        <input type="checkbox" data-id="${escHtml(item.id)}"
          aria-label="Select ${escHtml(item.path)}"
          ${isSelected ? 'checked' : ''} />
      </td>
      <td class="col-path">
        <span class="path-cell" title="${escHtml(item.path)}">${escHtml(item.path)}</span>
      </td>
      <td class="col-category">
        <span class="badge ${categoryBadgeClass(item.category)}">
          ${categoryLabel(item.category)}
        </span>
      </td>
      <td class="col-type">
        <span class="type-label">${item.type === 'directory' ? '📁 Dir' : '📄 File'}</span>
      </td>
      <td class="col-size">
        <span class="size-cell">${formatBytes(item.sizeBytes)}</span>
      </td>
    `;

    const checkbox = tr.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', () => toggleItem(item.id, checkbox.checked, tr));

    fragment.appendChild(tr);
  }

  resultsTbody.innerHTML = '';
  resultsTbody.appendChild(fragment);
  updateHeaderCheckbox();
  updateSummaryBar();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Selection management ──────────────────────────────────────────────────

function toggleItem(id, checked, trEl) {
  if (checked) {
    state.selectedIds.add(id);
    trEl.classList.add('selected-row');
  } else {
    state.selectedIds.delete(id);
    trEl.classList.remove('selected-row');
  }
  updateHeaderCheckbox();
  updateSummaryBar();
}

checkAllHeader.addEventListener('change', () => {
  const checked = checkAllHeader.checked;
  state.filteredItems.forEach((item) => {
    if (checked) state.selectedIds.add(item.id);
    else         state.selectedIds.delete(item.id);
  });
  renderTable();
  updateSummaryBar();
});

function updateHeaderCheckbox() {
  const visibleIds = state.filteredItems.map((i) => i.id);
  const selectedVisible = visibleIds.filter((id) => state.selectedIds.has(id));
  checkAllHeader.indeterminate =
    selectedVisible.length > 0 && selectedVisible.length < visibleIds.length;
  checkAllHeader.checked = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
}

// Category / all quick-select buttons
document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action   = btn.dataset.action;
    const category = btn.dataset.category;

    if (action === 'select-all') {
      state.allItems.forEach((i) => state.selectedIds.add(i.id));
    } else if (action === 'deselect-all') {
      state.selectedIds.clear();
    } else if (action === 'select-cat' && category) {
      state.allItems.filter((i) => i.category === category).forEach((i) => state.selectedIds.add(i.id));
    }

    renderTable();
    updateSummaryBar();
  });
});

// ── Summary bar ───────────────────────────────────────────────────────────

function updateSummaryBar() {
  const total = state.allItems.length;
  const totalBytes = state.allItems.reduce((s, i) => s + (i.sizeBytes || 0), 0);

  const selectedItems = state.allItems.filter((i) => state.selectedIds.has(i.id));
  const selectedBytes = selectedItems.reduce((s, i) => s + (i.sizeBytes || 0), 0);
  const selectedCount = selectedItems.length;

  sumFound.textContent = `${formatNumber(total)} item${total !== 1 ? 's' : ''}`;
  sumReclaimable.textContent = formatBytes(totalBytes);
  sumSelected.textContent = `${formatBytes(selectedBytes)} across ${formatNumber(selectedCount)} item${selectedCount !== 1 ? 's' : ''}`;

  const hasSelection = selectedCount > 0;
  btnDelete.disabled = !hasSelection;
  btnDelete.setAttribute('aria-disabled', String(!hasSelection));
}

// ── Delete flow ───────────────────────────────────────────────────────────

btnDelete.addEventListener('click', async () => {
  if (state.selectedIds.size === 0) return;

  const selectedItems = state.allItems.filter((i) => state.selectedIds.has(i.id));

  // Ask main process to build the preview (validates paths etc.)
  let preview;
  try {
    preview = await window.api.previewDelete(selectedItems);
  } catch (err) {
    alert(`Could not build preview: ${err.message}`);
    return;
  }

  state.pendingDeleteItems = preview.items;
  showConfirmModal(preview.items, preview.totalBytes);
});

function showConfirmModal(items, totalBytes) {
  confirmTotalSize.textContent = formatBytes(totalBytes);
  confirmItemCount.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;

  confirmPathList.innerHTML = '';
  items.forEach((item) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="confirm-path-text">${escHtml(item.path)}</span>
      <span class="confirm-path-size">${formatBytes(item.sizeBytes)}</span>
    `;
    confirmPathList.appendChild(li);
  });

  openModal(modalConfirm);
  // Focus the cancel button by default — user must deliberately click Confirm
  btnCancelConfirm.focus();
}

btnCancelConfirm.addEventListener('click', () => closeModal(modalConfirm));

btnConfirmDelete.addEventListener('click', async () => {
  if (!state.pendingDeleteItems) return;
  closeModal(modalConfirm);

  // Disable delete button during operation
  btnDelete.disabled = true;
  btnDelete.setAttribute('aria-disabled', 'true');
  progressText.textContent = 'Deleting…';
  progressTrack.classList.remove('hidden');
  progressStatus.classList.remove('hidden');

  let deleteResult;
  try {
    deleteResult = await window.api.confirmDelete(state.pendingDeleteItems);
  } catch (err) {
    alert(`Deletion error: ${err.message}`);
    setScanning(false);
    return;
  }

  progressTrack.classList.add('hidden');
  progressStatus.classList.add('hidden');

  // Remove successfully deleted items from allItems
  const deletedIds = new Set(
    deleteResult.results.filter((r) => r.success).map((r) => r.path)
  );

  state.allItems = state.allItems.filter((i) => !deletedIds.has(i.path));
  state.selectedIds.clear();
  state.pendingDeleteItems = null;

  showResultSummary(deleteResult);
});

function showResultSummary(result) {
  const successCount  = result.results.filter((r) => r.success).length;
  const failCount     = result.failureCount;
  const allSucceeded  = failCount === 0;

  resultIcon.textContent    = allSucceeded ? '✅' : '⚠️';
  resultHeadline.textContent = allSucceeded ? 'Deletion complete' : 'Deletion finished with errors';
  resultSub.textContent     = allSucceeded
    ? 'All selected items were permanently deleted.'
    : `${successCount} item${successCount !== 1 ? 's' : ''} deleted successfully, ${failCount} failed.`;

  statFreed.textContent    = formatBytes(result.totalFreed);
  statDeleted.textContent  = String(successCount);
  statFailures.textContent = String(failCount);

  if (failCount > 0) {
    failureDetails.classList.remove('hidden');
    failureList.innerHTML = '';
    result.results.filter((r) => !r.success).forEach((r) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="failure-path">${escHtml(r.path)}</div>
        <div class="failure-error">${escHtml(r.error || 'Unknown error')}</div>
      `;
      failureList.appendChild(li);
    });
  } else {
    failureDetails.classList.add('hidden');
  }

  showView('summary');
}

btnScanAgain.addEventListener('click', () => {
  // Reset and go back to idle
  state.allItems = [];
  state.filteredItems = [];
  state.selectedIds.clear();
  state.skippedPaths = [];
  state.pendingDeleteItems = null;
  resultsTbody.innerHTML = '';
  skippedNotice.classList.add('hidden');
  updateSummaryBar();

  // Restore idle-state copy text in case we changed it
  viewIdle.querySelector('.idle-title').textContent = 'Nothing scanned yet';
  viewIdle.querySelector('.idle-sub').innerHTML =
    'Choose a folder and click <strong>Scan</strong> to find reclaimable storage.';

  showView('idle');
});

// ── Skipped paths modal ───────────────────────────────────────────────────

btnShowSkipped.addEventListener('click', () => {
  skippedModalList.innerHTML = '';
  state.skippedPaths.forEach(({ path, reason }) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="skipped-path">${escHtml(path)}</div>
      <div class="skipped-reason">${escHtml(reason || '')}</div>
    `;
    skippedModalList.appendChild(li);
  });
  openModal(modalSkipped);
});

// ── Modal helpers ─────────────────────────────────────────────────────────

function openModal(el) {
  el.classList.remove('hidden');
  el.removeAttribute('aria-hidden');
  document.body.style.overflow = 'hidden';
  // Trap focus inside modal
  trapFocus(el);
}

function closeModal(el) {
  el.classList.add('hidden');
  el.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

// Close modal buttons (data-modal attribute points to the modal id)
document.querySelectorAll('.modal-close').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.modal;
    if (id) closeModal(document.getElementById(id));
  });
});

// Close modals on overlay click
[modalSkipped, modalConfirm].forEach((modal) => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal(modal);
  });
});

// Close modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    [modalSkipped, modalConfirm].forEach((m) => {
      if (!m.classList.contains('hidden')) closeModal(m);
    });
  }
});

/**
 * Rudimentary focus trap: cycles Tab/Shift+Tab within the modal.
 */
function trapFocus(modal) {
  const focusable = [
    ...modal.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ),
  ];
  if (focusable.length === 0) return;
  focusable[0].focus();

  function handler(e) {
    if (e.key !== 'Tab') return;
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
    }
  }

  modal.addEventListener('keydown', handler);

  // Clean up trap when modal closes (observer watches for class change)
  const obs = new MutationObserver(() => {
    if (modal.classList.contains('hidden')) {
      modal.removeEventListener('keydown', handler);
      obs.disconnect();
    }
  });
  obs.observe(modal, { attributes: true, attributeFilter: ['class'] });
}

// ── Initialise ────────────────────────────────────────────────────────────

showView('idle');
updateSummaryBar();
