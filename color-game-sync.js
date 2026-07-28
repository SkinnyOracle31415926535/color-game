(() => {
  'use strict';

  const migrationGate = (preview) => {
    if (!preview || !Number.isInteger(preview.writesPerformed) ||
        !Number.isInteger(preview.remoteCount) ||
        !Number.isInteger(preview.orphanedCount) ||
        preview.writesPerformed < 0 || preview.remoteCount < 0 ||
        preview.orphanedCount < 0) {
      return { safe: false, message: 'Migration is blocked because the preview counts are invalid.' };
    }
    if (preview.writesPerformed !== 0) {
      return { safe: false, message: 'Migration is blocked because the preview performed writes.' };
    }
    if (preview.remoteCount > 0) {
      return {
        safe: false,
        message: `Migration is blocked because ${preview.remoteCount} synchronized remote record` +
          `${preview.remoteCount === 1 ? '' : 's'} already exist.`,
      };
    }
    if (preview.orphanedCount > 0) {
      return {
        safe: false,
        message: `Migration is blocked because ${preview.orphanedCount} orphaned local sync intent` +
          `${preview.orphanedCount === 1 ? '' : 's'} need review.`,
      };
    }
    return { safe: true, message: 'Preview confirmed: 0 writes, 0 remote records, and 0 orphaned intents.' };
  };
  const requireSafeMigration = (preview) => {
    const gate = migrationGate(preview);
    if (!gate.safe) throw new Error(gate.message);
    return true;
  };
  window.ColorGameSyncPolicy = Object.freeze({ migrationGate, requireSafeMigration });

  const store = window.ColorGameStorage;
  const badgeRow = document.querySelector('.badge-row');
  if (!document.body || !badgeRow || !store) return;

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'color-game-sync-open';
  openButton.dataset.colorGameSyncOpen = '';
  openButton.dataset.state = 'disconnected';
  openButton.textContent = 'SYNC';
  openButton.setAttribute('aria-label', 'Open Color Game sync and backup');
  badgeRow.append(openButton);

  const dialog = document.createElement('dialog');
  dialog.className = 'color-game-sync-dialog';
  dialog.setAttribute('aria-labelledby', 'color-game-sync-title');
  dialog.innerHTML = `
    <div class="color-game-sync-window">
      <div class="color-game-sync-heading">
        <div>
          <p class="color-game-sync-kicker">RYAN-ONLY APP SYNC</p>
          <h2 id="color-game-sync-title">Sync & backup</h2>
        </div>
        <button type="button" class="color-game-sync-close" data-color-game-sync-close
          aria-label="Close sync and backup window">×</button>
      </div>
      <p class="color-game-sync-copy">
        Color and position settings, saved lists, the scoreboard, and sound preference
        can sync between Ryan’s browsers.
      </p>
      <p class="color-game-sync-safety">
        Only Color Game’s seven registered browser-storage keys are read.
        Other apps and temporary gameplay state are never scanned, replaced, or cleared.
      </p>
      <div class="color-game-sync-state" data-color-game-sync-state data-state="disconnected">
        <strong data-color-game-sync-state-label>Disconnected</strong>
        <span data-color-game-sync-state-message>Color Game records stay on this device.</span>
      </div>
      <p class="color-game-sync-alert" data-color-game-sync-alert role="alert" hidden></p>
      <div class="color-game-sync-actions">
        <button type="button" class="is-primary" data-color-game-sync-connect data-sync-action>
          Connect as Ryan
        </button>
        <button type="button" data-color-game-sync-now data-sync-action>Sync now</button>
        <button type="button" data-color-game-sync-backup data-sync-action>Download local backup</button>
        <button type="button" data-color-game-sync-preview data-sync-action>
          Create backup & preview
        </button>
        <button type="button" data-color-game-sync-disconnect data-sync-action>Disconnect</button>
        <button type="button" data-color-game-sync-reset data-sync-action>
          Reset device connection
        </button>
      </div>
      <section class="color-game-sync-review" data-color-game-sync-review hidden
        aria-labelledby="color-game-sync-review-title">
        <h3 id="color-game-sync-review-title">Migration preview</h3>
        <p data-color-game-sync-counts></p>
        <p class="color-game-sync-zero-write" data-color-game-sync-zero-write></p>
        <div class="color-game-sync-records" data-color-game-sync-records></div>
        <button type="button" class="is-primary" data-color-game-sync-apply
          data-sync-action disabled>Apply reviewed migration</button>
      </section>
      <section class="color-game-sync-conflicts" data-color-game-sync-conflicts hidden
        aria-labelledby="color-game-sync-conflicts-title">
        <h3 id="color-game-sync-conflicts-title">Sync conflicts</h3>
        <p>Choose each result deliberately. No choice is made automatically.</p>
        <div class="color-game-sync-conflict-list" data-color-game-sync-conflict-list></div>
      </section>
      <p class="color-game-sync-footnote">
        Player names stay inside Color Game’s app-owned records and are not placed in URLs or logs.
      </p>
      <p class="color-game-sync-footnote">
        If this browser was revoked, reset its device connection before reconnecting.
        All seven local Color Game values remain untouched.
      </p>
    </div>
  `;
  document.body.append(dialog);

  const closeButton = dialog.querySelector('[data-color-game-sync-close]');
  const connectButton = dialog.querySelector('[data-color-game-sync-connect]');
  const syncButton = dialog.querySelector('[data-color-game-sync-now]');
  const backupButton = dialog.querySelector('[data-color-game-sync-backup]');
  const previewButton = dialog.querySelector('[data-color-game-sync-preview]');
  const disconnectButton = dialog.querySelector('[data-color-game-sync-disconnect]');
  const resetButton = dialog.querySelector('[data-color-game-sync-reset]');
  const applyButton = dialog.querySelector('[data-color-game-sync-apply]');
  const stateBox = dialog.querySelector('[data-color-game-sync-state]');
  const stateLabel = dialog.querySelector('[data-color-game-sync-state-label]');
  const stateMessage = dialog.querySelector('[data-color-game-sync-state-message]');
  const alert = dialog.querySelector('[data-color-game-sync-alert]');
  const review = dialog.querySelector('[data-color-game-sync-review]');
  const counts = dialog.querySelector('[data-color-game-sync-counts]');
  const zeroWrite = dialog.querySelector('[data-color-game-sync-zero-write]');
  const records = dialog.querySelector('[data-color-game-sync-records]');
  const conflicts = dialog.querySelector('[data-color-game-sync-conflicts]');
  const conflictList = dialog.querySelector('[data-color-game-sync-conflict-list]');
  const actionButtons = Array.from(dialog.querySelectorAll('[data-sync-action]'));

  let client = null;
  let previewResult = null;
  let busy = false;
  let initialized = false;
  let conflictRender = 0;
  let restoreFocus = null;

  const stateLabels = {
    disconnected: 'Disconnected',
    review: 'Migration review required',
    syncing: 'Syncing',
    synced: 'Synced',
    offline: 'Offline',
    conflict: 'Conflict needs review',
  };

  const showAlert = (message = '') => {
    alert.hidden = !message;
    alert.textContent = message;
  };

  const setBusy = (next) => {
    busy = next;
    dialog.setAttribute('aria-busy', String(next));
    actionButtons.forEach((button) => {
      if (button === applyButton && !next) return;
      button.disabled = next;
    });
    if (!next) updateApplyAvailability();
  };

  const downloadJson = (payload, filename) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const downloadRawBackup = () => {
    const today = new Date().toISOString().slice(0, 10);
    downloadJson(store.rawBackup(), `color-game-browser-local-raw-backup-${today}.json`);
  };

  const invalidatePreview = () => {
    previewResult = null;
    review.hidden = true;
    records.replaceChildren();
    applyButton.disabled = true;
  };

  const updateApplyAvailability = () => {
    if (busy || !previewResult) {
      applyButton.disabled = true;
      return;
    }
    const required = Array.from(records.querySelectorAll('select[data-record-key]'));
    const blocked = records.querySelector('[data-migration-blocked]');
    const gate = migrationGate(previewResult.preview);
    applyButton.disabled = !gate.safe || Boolean(blocked) ||
      required.some((select) => !select.value);
  };

  const makeReviewRow = (item) => {
    const row = document.createElement('div');
    row.className = 'color-game-sync-record';
    const identity = document.createElement('strong');
    identity.textContent = `${item.collection} · ${item.recordId}`;
    const status = document.createElement('span');
    status.className = 'color-game-sync-record-status';
    status.textContent = String(item.status || '').replaceAll('-', ' ');
    row.append(identity, status);

    if (item.status === 'content-conflict') {
      const label = document.createElement('label');
      label.textContent = 'Choose result';
      const select = document.createElement('select');
      select.dataset.recordKey = item.recordKey;
      select.innerHTML = `
        <option value="">Choose…</option>
        <option value="keep-local">Keep this device</option>
        <option value="accept-remote">Accept synchronized record</option>
      `;
      select.addEventListener('change', updateApplyAvailability);
      label.append(select);
      row.append(label);
    } else if (item.status === 'schema-conflict' && item.localPresent) {
      const label = document.createElement('label');
      label.textContent = 'This app cannot import a different remote schema';
      const select = document.createElement('select');
      select.dataset.recordKey = item.recordKey;
      select.innerHTML = `
        <option value="">Choose…</option>
        <option value="keep-local">Keep this device</option>
      `;
      select.addEventListener('change', updateApplyAvailability);
      label.append(select);
      row.append(label);
    } else if (item.status === 'schema-conflict') {
      const blocked = document.createElement('p');
      blocked.dataset.migrationBlocked = '';
      blocked.textContent =
        'This remote record uses an unsupported schema. Migration is blocked without changing local data.';
      row.append(blocked);
    }
    return row;
  };

  const renderPreview = (result) => {
    previewResult = result;
    review.hidden = false;
    counts.textContent =
      `${result.preview.localCount} local · ${result.preview.remoteCount} synchronized · ` +
      `${result.preview.conflictCount} conflict${result.preview.conflictCount === 1 ? '' : 's'} · ` +
      `${result.preview.orphanedCount} orphaned`;
    const gate = migrationGate(result.preview);
    zeroWrite.textContent = gate.message;
    zeroWrite.dataset.safe = String(gate.safe);
    records.replaceChildren(...result.preview.review.map(makeReviewRow));
    if (!result.preview.review.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No registered local or synchronized records were found.';
      records.append(empty);
    }
    updateApplyAvailability();
  };

  const renderConflicts = async () => {
    if (!client) return;
    const renderId = ++conflictRender;
    const items = await client.listConflicts();
    if (renderId !== conflictRender) return;
    conflicts.hidden = items.length === 0;
    conflictList.replaceChildren();
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'color-game-sync-conflict';
      const title = document.createElement('strong');
      title.textContent = String(item.recordKey || '').split('\u001f').slice(-2).join(' · ');
      const reason = document.createElement('span');
      reason.textContent = `Reason: ${item.reason || 'conflict'}`;
      const actions = document.createElement('div');
      actions.className = 'color-game-sync-conflict-actions';
      const revision = Number.isInteger(item.current && item.current.revision)
        ? item.current.revision
        : 0;
      for (const [label, strategy] of [
        ['Keep this device', 'keep-local'],
        ['Accept remote', 'accept-remote'],
      ]) {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.textContent = label;
        choice.addEventListener('click', () => {
          void runAction(async () => {
            await client.resolveConflict(item.recordKey, {
              strategy,
              expectedRemoteRevision: revision,
            });
            await renderConflicts();
          });
        });
        actions.append(choice);
      }
      card.append(title, reason, actions);
      conflictList.append(card);
    }
  };

  const showState = (state) => {
    const mode = state && state.mode || 'disconnected';
    openButton.dataset.state = mode;
    openButton.title = state && state.message || 'Open sync and backup';
    stateBox.dataset.state = mode;
    stateLabel.textContent = stateLabels[mode] || mode;
    stateMessage.textContent = state && state.message || 'Color Game records remain on this device.';
    connectButton.hidden = mode !== 'disconnected';
    syncButton.hidden = !['synced', 'offline', 'conflict'].includes(mode);
    previewButton.hidden = mode !== 'review';
    disconnectButton.hidden = mode === 'disconnected';
    resetButton.hidden = mode !== 'disconnected';
    if (mode === 'conflict') void renderConflicts();
    else {
      conflictRender += 1;
      conflicts.hidden = true;
      conflictList.replaceChildren();
    }
  };

  const runAction = async (action) => {
    if (busy) return;
    showAlert('');
    setBusy(true);
    try {
      await action();
    } catch (error) {
      showAlert(error instanceof Error ? error.message : 'The action could not be completed safely.');
    } finally {
      setBusy(false);
    }
  };

  const initialize = async () => {
    if (!window.RyanAppSync || typeof window.RyanAppSync.create !== 'function') {
      throw new Error('Ryan App Sync is unavailable. Exact local backup still works.');
    }
    client = window.RyanAppSync.create({
      appId: store.appId,
      manifestVersion: store.schemaVersion,
      deviceLabel: `Color Game · ${navigator.platform || 'browser'}`,
      showStatus: false,
    });
    client.onStateChange(showState);
    const adapters = store.makeAdapters();
    const configuration = await client.register(adapters.configuration);
    const savedLists = await client.registerCollection(adapters.savedLists);
    const scoreboard = await client.register(adapters.scoreboard);
    const sound = await client.register(adapters.sound);
    await client.finalizeRegistration();
    store.attachHandles({ configuration, savedLists, scoreboard, sound });
    initialized = true;
    showState(client.getState());
    return true;
  };

  const ready = initialize().catch((error) => {
    showAlert(error instanceof Error ? error.message : 'Ryan App Sync could not initialize.');
    stateMessage.textContent =
      'Exact raw backup remains available; malformed local data is not overwritten.';
    connectButton.hidden = true;
    syncButton.hidden = true;
    previewButton.hidden = true;
    disconnectButton.hidden = true;
    resetButton.hidden = true;
    throw error;
  });
  ready.catch(() => {});

  openButton.addEventListener('click', () => {
    restoreFocus = document.activeElement;
    showAlert('');
    if (!dialog.open) dialog.showModal();
    closeButton.focus();
  });

  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (restoreFocus && typeof restoreFocus.focus === 'function') restoreFocus.focus();
    restoreFocus = null;
  });

  connectButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.connect();
    });
  });

  syncButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.sync();
    });
  });

  backupButton.addEventListener('click', () => {
    void runAction(async () => {
      downloadRawBackup();
      if (initialized) await client.exportBackup(true);
    });
  });

  previewButton.addEventListener('click', () => {
    void runAction(async () => {
      downloadRawBackup();
      await ready;
      const result = await client.previewMigration({ downloadBackup: true });
      renderPreview(result);
    });
  });

  applyButton.addEventListener('click', () => {
    void runAction(async () => {
      if (!previewResult) throw new Error('Create and review a fresh migration preview.');
      requireSafeMigration(previewResult.preview);
      const resolutions = {};
      records.querySelectorAll('select[data-record-key]').forEach((select) => {
        if (select.value) resolutions[select.dataset.recordKey] = select.value;
      });
      await client.applyMigration(previewResult.plan, resolutions);
      invalidatePreview();
    });
  });

  disconnectButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.disconnect();
      invalidatePreview();
    });
  });

  resetButton.addEventListener('click', () => {
    void runAction(async () => {
      await ready;
      await client.resetDevice();
      invalidatePreview();
      showAlert(
        'Device connection reset. All seven local Color Game values were preserved. ' +
        'Connect again and review a fresh migration preview.'
      );
    });
  });

  window.ColorGameSync = Object.freeze({
    appId: store.appId,
    manifestVersion: store.schemaVersion,
    ready,
    open: () => openButton.click(),
    rawBackup: store.rawBackup,
  });
})();
