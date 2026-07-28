(() => {
  'use strict';

  const APP_ID = 'color-game';
  const SCHEMA_VERSION = 1;
  const CHANGE_EVENT = 'color-game:persistent-state-change';
  const AGGREGATE_LOCK = 'color-game:sync-local-aggregate-v2';
  const STORAGE_KEYS = Object.freeze({
    colors: 'colorPositionColors',
    positions: 'colorPositionPositions',
    hiddenColors: 'colorPositionHiddenColors',
    colorPercentages: 'colorPositionColorPercentages',
    namedLists: 'colorPositionNamedLists',
    scores: 'colorPositionScores',
    sound: 'colorPositionSound',
  });
  const RAW_BACKUP_KEYS = Object.freeze([
    STORAGE_KEYS.colors,
    STORAGE_KEYS.positions,
    STORAGE_KEYS.hiddenColors,
    STORAGE_KEYS.colorPercentages,
    STORAGE_KEYS.namedLists,
    STORAGE_KEYS.scores,
    STORAGE_KEYS.sound,
  ]);
  const CONFIGURATION_KEYS = Object.freeze([
    STORAGE_KEYS.colors,
    STORAGE_KEYS.positions,
    STORAGE_KEYS.hiddenColors,
    STORAGE_KEYS.colorPercentages,
  ]);
  const DEFAULT_COLOR_NAMES = Object.freeze([
    'red', 'orange', 'yellow', 'green', 'blue',
    'purple', 'pink', 'white', 'black', 'teal',
  ]);
  const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const GROUP_NAMES = Object.freeze([
    'configuration', 'saved-lists', 'scoreboard', 'preferences',
  ]);
  const mutationStates = new Map(GROUP_NAMES.map((name) => [name, {
    issuedGeneration: 0,
    committedGeneration: 0,
    pending: [],
    inFlightGeneration: 0,
    draining: false,
    editorActive: false,
    editorDirty: false,
  }]));
  let handles = null;

  const stateFor = (group) => {
    const state = mutationStates.get(group);
    if (!state) throw new Error('The Color Game storage group is invalid.');
    return state;
  };

  const withAggregateLock = (task) => {
    const locks = window.navigator && window.navigator.locks;
    if (!locks || typeof locks.request !== 'function') {
      return Promise.reject(
        new Error('Shared browser locking is unavailable. Local Color Game data was not changed.')
      );
    }
    return locks.request(AGGREGATE_LOCK, { mode: 'exclusive' }, task);
  };

  const dataObjectDescriptors = (value) => {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') return null;
        const descriptor = descriptors[key];
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
            descriptor.get || descriptor.set || !descriptor.enumerable) {
          return null;
        }
      }
      return descriptors;
    } catch (_error) {
      return null;
    }
  };

  const plainObject = (value) => Boolean(dataObjectDescriptors(value));

  const safeKeys = (value) => {
    const descriptors = dataObjectDescriptors(value);
    return descriptors ? Object.keys(descriptors) : null;
  };

  const safeEntries = (value) => {
    const descriptors = dataObjectDescriptors(value);
    return descriptors
      ? Object.keys(descriptors).map((key) => [key, descriptors[key].value])
      : null;
  };

  const exactKeys = (value, expected) => {
    const keys = safeKeys(value);
    return Boolean(keys &&
      keys.sort().join('\u001f') === expected.slice().sort().join('\u001f'));
  };

  const safeArrayValues = (value, maximum) => {
    try {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
          value.length > maximum) {
        return null;
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const ownKeys = Reflect.ownKeys(descriptors);
      if (ownKeys.some((key) => typeof key !== 'string') ||
          ownKeys.length !== value.length + 1 ||
          !descriptors.length || descriptors.length.value !== value.length) {
        return null;
      }
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
            descriptor.get || descriptor.set || !descriptor.enumerable) {
          return null;
        }
        result.push(descriptor.value);
      }
      return result;
    } catch (_error) {
      return null;
    }
  };

  const safeJsonParse = (raw, label) => {
    try {
      return JSON.parse(raw);
    } catch (_error) {
      throw new Error(`${label} needs a raw backup and review before it can be changed or synchronized.`);
    }
  };

  const hasControlCharacters = (value) => /[\u0000-\u001f\u007f]/.test(value);

  const captureRaw = (keys) => keys.map((key) => ({
    key,
    raw: window.localStorage.getItem(key),
  }));

  const assertRawUnchanged = (snapshot, label) => {
    if (snapshot.some(({ key, raw }) => window.localStorage.getItem(key) !== raw)) {
      throw new Error(`${label} changed during an atomic update. The newer local value was preserved.`);
    }
  };

  const restoreRaw = (snapshot) => {
    for (const { key, raw } of snapshot) {
      if (raw === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, raw);
    }
  };

  const compareAndSet = (snapshot, changes, label) => {
    assertRawUnchanged(snapshot, label);
    try {
      for (const { key, raw } of changes) {
        if (raw === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, raw);
      }
      for (const { key, raw } of changes) {
        if (window.localStorage.getItem(key) !== raw) {
          throw new Error(`${label} could not be verified after writing.`);
        }
      }
    } catch (error) {
      restoreRaw(snapshot);
      throw error;
    }
  };

  const parseColorText = (value, label = 'Color data') => {
    if (typeof value !== 'string' || value.length > 32_768) {
      throw new Error(`${label} needs a raw backup and review before it can be changed or synchronized.`);
    }
    const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length || lines.length > 64) {
      throw new Error(`${label} needs a raw backup and review before it can be changed or synchronized.`);
    }
    const names = new Set();
    for (const line of lines) {
      const match = /^([^:]{1,64}):\s*(#[0-9a-f]{6})$/i.exec(line);
      const name = match && match[1].trim();
      if (!match || !name || hasControlCharacters(name)) {
        throw new Error(`${label} needs a raw backup and review before it can be changed or synchronized.`);
      }
      const key = name.toLowerCase();
      if (names.has(key) || RESERVED_KEYS.has(key)) {
        throw new Error(`${label} contains an unsafe or duplicate color name and needs review.`);
      }
      names.add(key);
    }
    return names;
  };

  const parsePositionText = (value, label = 'Position data') => {
    if (typeof value !== 'string' || value.length > 32_768) {
      throw new Error(`${label} needs a raw backup and review before it can be changed or synchronized.`);
    }
    const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length || lines.length > 128 ||
        lines.some((line) => line.length > 120 || hasControlCharacters(line))) {
      throw new Error(`${label} needs a raw backup and review before it can be changed or synchronized.`);
    }
    return lines;
  };

  const validateHiddenColors = (value, activeNames) => {
    const values = safeArrayValues(value, 64);
    if (!values) return false;
    const seen = new Set();
    for (const name of values) {
      if (typeof name !== 'string' || !name || name !== name.toLowerCase() ||
          RESERVED_KEYS.has(name) || seen.has(name) || !activeNames.has(name)) {
        return false;
      }
      seen.add(name);
    }
    return true;
  };

  const validateColorPercentages = (value, activeNames) => {
    const entries = safeEntries(value);
    if (!entries || entries.length > 64) return false;
    let total = 0;
    for (const [name, percentage] of entries) {
      if (!name || name !== name.toLowerCase() || RESERVED_KEYS.has(name) ||
          !activeNames.has(name) || !Number.isFinite(percentage) ||
          percentage < 0 || percentage > 100) {
        return false;
      }
      total += percentage;
    }
    return entries.length === 0 || total > 0;
  };

  const validateConfiguration = (candidate) => {
    if (!exactKeys(candidate, [
      'version', 'colorsText', 'positionsText', 'hiddenColors', 'colorPercentages',
    ])) {
      return false;
    }
    const entries = Object.fromEntries(safeEntries(candidate));
    if (entries.version !== SCHEMA_VERSION ||
        !(entries.colorsText === null || typeof entries.colorsText === 'string') ||
        !(entries.positionsText === null || typeof entries.positionsText === 'string')) {
      return false;
    }
    try {
      const activeNames = entries.colorsText === null
        ? new Set(DEFAULT_COLOR_NAMES)
        : parseColorText(entries.colorsText);
      if (entries.positionsText !== null) parsePositionText(entries.positionsText);
      return validateHiddenColors(entries.hiddenColors, activeNames) &&
        validateColorPercentages(entries.colorPercentages, activeNames);
    } catch (_error) {
      return false;
    }
  };

  const canonicalConfiguration = (candidate) => {
    const entries = Object.fromEntries(safeEntries(candidate));
    const percentages = Object.create(null);
    for (const [name, value] of safeEntries(entries.colorPercentages)) {
      percentages[name] = value;
    }
    return {
      version: SCHEMA_VERSION,
      colorsText: entries.colorsText,
      positionsText: entries.positionsText,
      hiddenColors: safeArrayValues(entries.hiddenColors, 64).slice(),
      colorPercentages: percentages,
    };
  };

  const readConfigurationFromSnapshot = (snapshot) => {
    const rawByKey = new Map(snapshot.map(({ key, raw }) => [key, raw]));
    const colorsText = rawByKey.get(STORAGE_KEYS.colors);
    const positionsText = rawByKey.get(STORAGE_KEYS.positions);
    const hiddenRaw = rawByKey.get(STORAGE_KEYS.hiddenColors);
    const percentagesRaw = rawByKey.get(STORAGE_KEYS.colorPercentages);
    if ([colorsText, positionsText, hiddenRaw, percentagesRaw].every((value) => value === null)) {
      return undefined;
    }
    const value = {
      version: SCHEMA_VERSION,
      colorsText,
      positionsText,
      hiddenColors: hiddenRaw === null ? [] : safeJsonParse(hiddenRaw, 'Hidden color data'),
      colorPercentages: percentagesRaw === null
        ? Object.create(null)
        : safeJsonParse(percentagesRaw, 'Color percentage data'),
    };
    if (!validateConfiguration(value)) {
      throw new Error(
        'Local color and position configuration needs a raw backup and review before it can be changed or synchronized.'
      );
    }
    return canonicalConfiguration(value);
  };

  const readConfigurationUnlocked = () =>
    readConfigurationFromSnapshot(captureRaw(CONFIGURATION_KEYS));

  const listNameValid = (name) =>
    typeof name === 'string' && name === name.trim() && name.length >= 1 &&
    name.length <= 80 && !hasControlCharacters(name) && !RESERVED_KEYS.has(name);

  const validateNamedList = (candidate, recordId = '') => {
    if (!/^list-[a-f0-9]{64}$/.test(recordId) ||
        !exactKeys(candidate, [
          'version', 'name', 'colors', 'positions', 'hiddenColors', 'colorPercentages',
        ])) {
      return false;
    }
    const entries = Object.fromEntries(safeEntries(candidate));
    if (entries.version !== SCHEMA_VERSION || !listNameValid(entries.name)) return false;
    try {
      const activeNames = parseColorText(entries.colors, `Saved list ${entries.name}`);
      parsePositionText(entries.positions, `Saved list ${entries.name}`);
      return validateHiddenColors(entries.hiddenColors, activeNames) &&
        validateColorPercentages(entries.colorPercentages, activeNames);
    } catch (_error) {
      return false;
    }
  };

  const canonicalNamedList = (candidate) => {
    const entries = Object.fromEntries(safeEntries(candidate));
    const percentages = Object.create(null);
    for (const [name, value] of safeEntries(entries.colorPercentages)) {
      percentages[name] = value;
    }
    return {
      version: SCHEMA_VERSION,
      name: entries.name,
      colors: entries.colors,
      positions: entries.positions,
      hiddenColors: safeArrayValues(entries.hiddenColors, 64).slice(),
      colorPercentages: percentages,
    };
  };

  const legacyListToSync = (name, candidate) => {
    if (!exactKeys(candidate, [
      'colors', 'positions', 'hiddenColors', 'colorPercentages',
    ])) {
      return null;
    }
    const entries = Object.fromEntries(safeEntries(candidate));
    return {
      version: SCHEMA_VERSION,
      name,
      colors: entries.colors,
      positions: entries.positions,
      hiddenColors: entries.hiddenColors,
      colorPercentages: entries.colorPercentages,
    };
  };

  const syncListToLegacy = (candidate) => {
    const canonical = canonicalNamedList(candidate);
    const percentages = Object.create(null);
    for (const [name, value] of safeEntries(canonical.colorPercentages)) {
      percentages[name] = value;
    }
    const result = Object.create(null);
    result.colors = canonical.colors;
    result.positions = canonical.positions;
    result.hiddenColors = canonical.hiddenColors.slice();
    result.colorPercentages = percentages;
    return result;
  };

  const readNamedListsFromRaw = (raw) => {
    if (raw === null) return Object.create(null);
    const parsed = safeJsonParse(raw, 'Saved list data');
    const entries = safeEntries(parsed);
    if (!entries || entries.length > 128) {
      throw new Error('Local saved list data needs a raw backup and review before it can be changed or synchronized.');
    }
    const result = Object.create(null);
    for (const [name, value] of entries) {
      const provisional = legacyListToSync(name, value);
      if (!listNameValid(name) || !provisional ||
          !validateNamedList(provisional, `list-${'0'.repeat(64)}`)) {
        throw new Error(`Local saved list ${name || '(unnamed)'} needs a raw backup and review.`);
      }
      result[name] = syncListToLegacy(provisional);
    }
    return result;
  };

  const readNamedListsUnlocked = () =>
    readNamedListsFromRaw(window.localStorage.getItem(STORAGE_KEYS.namedLists));

  const validateScoreboard = (candidate) => {
    if (!exactKeys(candidate, ['version', 'players'])) return false;
    const entries = Object.fromEntries(safeEntries(candidate));
    const players = safeArrayValues(entries.players, 100);
    if (entries.version !== SCHEMA_VERSION || !players || !players.length) return false;
    return players.every((player) => {
      if (!exactKeys(player, ['name', 'points'])) return false;
      const values = Object.fromEntries(safeEntries(player));
      return typeof values.name === 'string' && values.name.length <= 80 &&
        !hasControlCharacters(values.name) && Number.isSafeInteger(values.points) &&
        values.points >= -9_999 && values.points <= 999_999;
    });
  };

  const canonicalScoreboard = (candidate) => {
    const entries = Object.fromEntries(safeEntries(candidate));
    return {
      version: SCHEMA_VERSION,
      players: safeArrayValues(entries.players, 100).map((player) => {
        const values = Object.fromEntries(safeEntries(player));
        return { name: values.name, points: values.points };
      }),
    };
  };

  const readScoreboardFromRaw = (raw) => {
    if (raw === null) return undefined;
    const value = {
      version: SCHEMA_VERSION,
      players: safeJsonParse(raw, 'Scoreboard data'),
    };
    if (!validateScoreboard(value)) {
      throw new Error('Local scoreboard data needs a raw backup and review before it can be changed or synchronized.');
    }
    return canonicalScoreboard(value);
  };

  const readScoreboardUnlocked = () =>
    readScoreboardFromRaw(window.localStorage.getItem(STORAGE_KEYS.scores));

  const validateSound = (candidate) => {
    if (!exactKeys(candidate, ['version', 'enabled'])) return false;
    const entries = Object.fromEntries(safeEntries(candidate));
    return entries.version === SCHEMA_VERSION && typeof entries.enabled === 'boolean';
  };

  const readSoundFromRaw = (raw) => {
    if (raw === null) return undefined;
    if (!['on', 'off'].includes(raw)) {
      throw new Error('Local sound preference needs a raw backup and review before it can be changed or synchronized.');
    }
    return { version: SCHEMA_VERSION, enabled: raw === 'on' };
  };

  const readSoundUnlocked = () =>
    readSoundFromRaw(window.localStorage.getItem(STORAGE_KEYS.sound));

  const dispatchChange = (collection, source) => {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, {
      detail: { collection, source },
    }));
  };

  const localWorkPending = (state) =>
    Boolean(state.pending.length || state.inFlightGeneration);

  const assertConsistentRead = (group) => {
    const state = stateFor(group);
    if (localWorkPending(state) || state.editorActive || state.editorDirty) {
      throw new Error(`Local ${group} edits must settle before synchronization can read them.`);
    }
  };

  const assertRemoteWritable = (group, generation) => {
    const state = stateFor(group);
    if (state.issuedGeneration !== generation || localWorkPending(state) ||
        state.editorActive || state.editorDirty) {
      throw new Error(
        `Remote ${group} data was not applied because a newer local edit needs review.`
      );
    }
  };

  const withConsistentRead = (group, task) => withAggregateLock(() => {
    assertConsistentRead(group);
    return task();
  });

  const withRemoteWrite = (group, task) => {
    const generation = stateFor(group).issuedGeneration;
    assertRemoteWritable(group, generation);
    return withAggregateLock(async () => {
      assertRemoteWritable(group, generation);
      const assertCurrent = () => assertRemoteWritable(group, generation);
      return task(assertCurrent);
    });
  };

  const enqueueLatest = (group, coalesceKey, perform) => {
    const state = stateFor(group);
    const generation = ++state.issuedGeneration;
    const promise = new Promise((resolve, reject) => {
      const pending = state.pending.find((job) => job.coalesceKey === coalesceKey);
      if (!pending) {
        state.pending.push({ coalesceKey, generation, perform, waiters: [{ resolve, reject }] });
      } else {
        pending.generation = generation;
        pending.perform = perform;
        pending.waiters.push({ resolve, reject });
      }
    });

    if (!state.draining) {
      state.draining = true;
      Promise.resolve().then(async () => {
        try {
          while (state.pending.length) {
            const job = state.pending.shift();
            state.inFlightGeneration = job.generation;
            try {
              const result = await job.perform(job.generation);
              state.committedGeneration = Math.max(
                state.committedGeneration,
                job.generation,
              );
              job.waiters.forEach(({ resolve }) => resolve(result));
            } catch (error) {
              job.waiters.forEach(({ reject }) => reject(error));
            } finally {
              state.inFlightGeneration = 0;
            }
          }
        } finally {
          state.draining = false;
        }
      });
    }
    return promise;
  };

  const setEditorState = (group, update) => {
    const state = stateFor(group);
    if (!plainObject(update)) throw new Error('The editor state is invalid.');
    const entries = Object.fromEntries(safeEntries(update));
    if (Object.prototype.hasOwnProperty.call(entries, 'active')) {
      if (typeof entries.active !== 'boolean') throw new Error('The editor state is invalid.');
      state.editorActive = entries.active;
    }
    if (Object.prototype.hasOwnProperty.call(entries, 'dirty')) {
      if (typeof entries.dirty !== 'boolean') throw new Error('The editor state is invalid.');
      state.editorDirty = entries.dirty;
    }
  };

  const applyConfigurationUnlocked = (candidate, source, assertCurrent = () => {}) => {
    const snapshot = captureRaw(CONFIGURATION_KEYS);
    readConfigurationFromSnapshot(snapshot);
    if (!validateConfiguration(candidate)) {
      throw new Error('The synchronized color and position configuration is invalid.');
    }
    const value = canonicalConfiguration(candidate);
    assertCurrent();
    compareAndSet(snapshot, [
      { key: STORAGE_KEYS.colors, raw: value.colorsText },
      { key: STORAGE_KEYS.positions, raw: value.positionsText },
      { key: STORAGE_KEYS.hiddenColors, raw: JSON.stringify(value.hiddenColors) },
      {
        key: STORAGE_KEYS.colorPercentages,
        raw: JSON.stringify(value.colorPercentages),
      },
    ], 'Color and position configuration');
    dispatchChange('configuration', source);
    return true;
  };

  const sha256 = async (value) => {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('Secure hashing is required to synchronize saved lists.');
    }
    const digest = await window.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')).join('');
  };

  const listRecordId = async (name) => {
    if (!listNameValid(name)) throw new Error('The saved list name is invalid.');
    return `list-${await sha256(name)}`;
  };

  const identifyNamedLists = async (namedLists) => {
    const records = await Promise.all(safeEntries(namedLists).map(async ([name, value]) => ({
      name,
      recordId: await listRecordId(name),
      value: canonicalNamedList(legacyListToSync(name, value)),
    })));
    if (new Set(records.map(({ recordId }) => recordId)).size !== records.length) {
      throw new Error('Local saved list identities collide and need a raw backup and review.');
    }
    return records;
  };

  const listNamedListsUnlocked = async () => {
    const snapshot = captureRaw([STORAGE_KEYS.namedLists]);
    const namedLists = readNamedListsFromRaw(snapshot[0].raw);
    const records = await identifyNamedLists(namedLists);
    assertRawUnchanged(snapshot, 'Saved list data');
    return records.map(({ recordId, value }) => ({ recordId, value }));
  };

  const applyNamedListUnlocked = async (
    recordId,
    candidate,
    deleted,
    source,
    assertCurrent = () => {},
  ) => {
    if (!/^list-[a-f0-9]{64}$/.test(recordId || '')) {
      throw new Error('The synchronized saved list ID is invalid.');
    }
    const snapshot = captureRaw([STORAGE_KEYS.namedLists]);
    const namedLists = readNamedListsFromRaw(snapshot[0].raw);
    const identified = await identifyNamedLists(namedLists);
    const matches = identified.filter((item) => item.recordId === recordId);
    if (matches.length > 1) {
      throw new Error('Local saved list identities collide and need a raw backup and review.');
    }
    const next = Object.create(null);
    for (const [name, value] of safeEntries(namedLists)) next[name] = value;
    if (deleted) {
      if (!matches.length) {
        assertCurrent();
        assertRawUnchanged(snapshot, 'Saved list data');
        return true;
      }
      delete next[matches[0].name];
    } else {
      if (!validateNamedList(candidate, recordId)) {
        throw new Error('The synchronized saved list is invalid.');
      }
      const canonical = canonicalNamedList(candidate);
      if (await listRecordId(canonical.name) !== recordId) {
        throw new Error('The synchronized saved list identity does not match its name.');
      }
      if (matches.length && matches[0].name !== canonical.name) {
        throw new Error('The synchronized saved list identity collides with local data.');
      }
      next[canonical.name] = syncListToLegacy(canonical);
    }
    assertCurrent();
    compareAndSet(snapshot, [{
      key: STORAGE_KEYS.namedLists,
      raw: JSON.stringify(next),
    }], 'Saved list data');
    dispatchChange('saved-lists', source);
    return true;
  };

  const applyScoreboardUnlocked = (candidate, source, assertCurrent = () => {}) => {
    const snapshot = captureRaw([STORAGE_KEYS.scores]);
    readScoreboardFromRaw(snapshot[0].raw);
    if (!validateScoreboard(candidate)) {
      throw new Error('The synchronized scoreboard is invalid.');
    }
    const value = canonicalScoreboard(candidate);
    assertCurrent();
    compareAndSet(snapshot, [{
      key: STORAGE_KEYS.scores,
      raw: JSON.stringify(value.players),
    }], 'Scoreboard data');
    dispatchChange('scoreboard', source);
    return true;
  };

  const applySoundUnlocked = (candidate, source, assertCurrent = () => {}) => {
    const snapshot = captureRaw([STORAGE_KEYS.sound]);
    readSoundFromRaw(snapshot[0].raw);
    if (!validateSound(candidate)) {
      throw new Error('The synchronized sound preference is invalid.');
    }
    const value = Object.fromEntries(safeEntries(candidate));
    assertCurrent();
    compareAndSet(snapshot, [{
      key: STORAGE_KEYS.sound,
      raw: value.enabled ? 'on' : 'off',
    }], 'Sound preference');
    dispatchChange('preferences', source);
    return true;
  };

  const requireWriteSource = (metadata) => {
    if (!metadata || !['local', 'remote-migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid local write source.');
    }
  };

  const requireRemoteSource = (metadata) => {
    if (!metadata || !['remote', 'migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid remote write source.');
    }
  };

  const rejectFixedTombstone = (metadata, label) => {
    if (metadata && metadata.deleted) {
      throw new Error(`${label} is a fixed record and cannot be deleted.`);
    }
  };

  const localOrMigratedWrite = (group, metadata, task) => {
    requireWriteSource(metadata);
    return metadata.source === 'remote-migration'
      ? withRemoteWrite(group, task)
      : withAggregateLock(() => task(() => {}));
  };

  const makeAdapters = () => ({
    configuration: {
      scope: APP_ID,
      appId: APP_ID,
      collection: 'configuration',
      recordId: 'current',
      schemaVersion: SCHEMA_VERSION,
      validate: validateConfiguration,
      readLocal: () => withConsistentRead('configuration', readConfigurationUnlocked),
      writeLocal: (value, metadata) => {
        rejectFixedTombstone(metadata, 'Configuration');
        return localOrMigratedWrite('configuration', metadata, (assertCurrent) =>
          applyConfigurationUnlocked(value, metadata.source, assertCurrent));
      },
      applyRemote: (value, metadata) => {
        requireRemoteSource(metadata);
        rejectFixedTombstone(metadata, 'Configuration');
        return withRemoteWrite('configuration', (assertCurrent) =>
          applyConfigurationUnlocked(value, metadata.source, assertCurrent));
      },
    },
    savedLists: {
      scope: APP_ID,
      appId: APP_ID,
      collection: 'saved-lists',
      schemaVersion: SCHEMA_VERSION,
      validate: validateNamedList,
      listLocal: () => withConsistentRead('saved-lists', listNamedListsUnlocked),
      writeLocal: (recordId, value, metadata) =>
        localOrMigratedWrite('saved-lists', metadata, (assertCurrent) =>
          applyNamedListUnlocked(
            recordId,
            value,
            Boolean(metadata.deleted),
            metadata.source,
            assertCurrent,
          )),
      applyRemote: (recordId, value, metadata) => {
        requireRemoteSource(metadata);
        return withRemoteWrite('saved-lists', (assertCurrent) =>
          applyNamedListUnlocked(
            recordId,
            value,
            Boolean(metadata.deleted),
            metadata.source,
            assertCurrent,
          ));
      },
    },
    scoreboard: {
      scope: APP_ID,
      appId: APP_ID,
      collection: 'scoreboard',
      recordId: 'current',
      schemaVersion: SCHEMA_VERSION,
      validate: validateScoreboard,
      readLocal: () => withConsistentRead('scoreboard', readScoreboardUnlocked),
      writeLocal: (value, metadata) => {
        rejectFixedTombstone(metadata, 'Scoreboard');
        return localOrMigratedWrite('scoreboard', metadata, (assertCurrent) =>
          applyScoreboardUnlocked(value, metadata.source, assertCurrent));
      },
      applyRemote: (value, metadata) => {
        requireRemoteSource(metadata);
        rejectFixedTombstone(metadata, 'Scoreboard');
        return withRemoteWrite('scoreboard', (assertCurrent) =>
          applyScoreboardUnlocked(value, metadata.source, assertCurrent));
      },
    },
    sound: {
      scope: APP_ID,
      appId: APP_ID,
      collection: 'preferences',
      recordId: 'sound',
      schemaVersion: SCHEMA_VERSION,
      validate: validateSound,
      readLocal: () => withConsistentRead('preferences', readSoundUnlocked),
      writeLocal: (value, metadata) => {
        rejectFixedTombstone(metadata, 'Sound preference');
        return localOrMigratedWrite('preferences', metadata, (assertCurrent) =>
          applySoundUnlocked(value, metadata.source, assertCurrent));
      },
      applyRemote: (value, metadata) => {
        requireRemoteSource(metadata);
        rejectFixedTombstone(metadata, 'Sound preference');
        return withRemoteWrite('preferences', (assertCurrent) =>
          applySoundUnlocked(value, metadata.source, assertCurrent));
      },
    },
  });

  const attachHandles = (next) => {
    if (!exactKeys(next, ['configuration', 'savedLists', 'scoreboard', 'sound'])) {
      throw new Error('Color Game sync handles are incomplete.');
    }
    const entries = Object.fromEntries(safeEntries(next));
    if (![entries.configuration, entries.scoreboard, entries.sound]
      .every((handle) => handle && typeof handle.save === 'function') ||
        !entries.savedLists || typeof entries.savedLists.save !== 'function' ||
        typeof entries.savedLists.remove !== 'function') {
      throw new Error('Color Game sync handles are incomplete.');
    }
    handles = Object.freeze({ ...entries });
  };

  const saveConfiguration = (candidate) => {
    if (!validateConfiguration(candidate)) {
      return Promise.reject(new Error('The color and position configuration is invalid.'));
    }
    const value = canonicalConfiguration(candidate);
    return enqueueLatest('configuration', 'current', () => (
      handles
        ? handles.configuration.save(value)
        : withAggregateLock(() => applyConfigurationUnlocked(value, 'local'))
    ));
  };

  const resetConfiguration = () => saveConfiguration({
    version: SCHEMA_VERSION,
    colorsText: null,
    positionsText: null,
    hiddenColors: [],
    colorPercentages: Object.create(null),
  });

  const saveNamedList = (candidate) => {
    if (!validateNamedList(candidate, `list-${'0'.repeat(64)}`)) {
      return Promise.reject(new Error('The saved list is invalid.'));
    }
    const value = canonicalNamedList(candidate);
    return enqueueLatest('saved-lists', value.name, async () => {
      const recordId = await listRecordId(value.name);
      if (!validateNamedList(value, recordId)) throw new Error('The saved list is invalid.');
      return handles
        ? handles.savedLists.save(recordId, value)
        : withAggregateLock(() =>
            applyNamedListUnlocked(recordId, value, false, 'local'));
    });
  };

  const removeNamedList = (name) => {
    if (!listNameValid(name)) return Promise.reject(new Error('The saved list name is invalid.'));
    return enqueueLatest('saved-lists', name, async () => {
      const recordId = await listRecordId(name);
      return handles
        ? handles.savedLists.remove(recordId)
        : withAggregateLock(() =>
            applyNamedListUnlocked(recordId, null, true, 'local'));
    });
  };

  const saveScoreboard = (players) => {
    const value = { version: SCHEMA_VERSION, players };
    if (!validateScoreboard(value)) {
      return Promise.reject(new Error('The scoreboard is invalid.'));
    }
    const canonical = canonicalScoreboard(value);
    return enqueueLatest('scoreboard', 'current', () => (
      handles
        ? handles.scoreboard.save(canonical)
        : withAggregateLock(() => applyScoreboardUnlocked(canonical, 'local'))
    ));
  };

  const saveSound = (enabled) => {
    const value = { version: SCHEMA_VERSION, enabled };
    if (!validateSound(value)) {
      return Promise.reject(new Error('The sound preference is invalid.'));
    }
    return enqueueLatest('preferences', 'sound', () => (
      handles
        ? handles.sound.save(value)
        : withAggregateLock(() => applySoundUnlocked(value, 'local'))
    ));
  };

  const readNamedListsForDisplay = () => {
    try {
      return readNamedListsUnlocked();
    } catch (_error) {
      return Object.create(null);
    }
  };

  const assertOwnedStorageValid = () => {
    readConfigurationUnlocked();
    readNamedListsUnlocked();
    readScoreboardUnlocked();
    readSoundUnlocked();
    return true;
  };

  const rawBackup = () => ({
    version: 1,
    kind: 'color_game_browser_local_raw_backup',
    app_id: APP_ID,
    exported_at: new Date().toISOString(),
    records: RAW_BACKUP_KEYS.map((key) => {
      const rawValue = window.localStorage.getItem(key);
      return {
        key,
        present: rawValue !== null,
        raw_value: rawValue,
      };
    }),
  });

  window.ColorGameStorage = Object.freeze({
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    changeEvent: CHANGE_EVENT,
    aggregateLock: AGGREGATE_LOCK,
    storageKeys: STORAGE_KEYS,
    rawBackupKeys: RAW_BACKUP_KEYS,
    rawBackup,
    makeAdapters,
    attachHandles,
    listRecordId,
    readNamedListsForDisplay,
    assertOwnedStorageValid,
    setEditorState,
    saveConfiguration,
    resetConfiguration,
    saveNamedList,
    removeNamedList,
    saveScoreboard,
    saveSound,
  });
})();
