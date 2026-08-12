(() => {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STORAGE_KEYS = Object.freeze({
    colors: 'colorPositionColors',
    positions: 'colorPositionPositions',
    hiddenColors: 'colorPositionHiddenColors',
    colorPercentages: 'colorPositionColorPercentages',
    namedLists: 'colorPositionNamedLists',
    scores: 'colorPositionScores',
    sound: 'colorPositionSound',
  });
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
      throw new Error(`${label} needs a raw backup and review before it can be changed.`);
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
      throw new Error(`${label} needs a raw backup and review before it can be changed.`);
    }
    const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length || lines.length > 64) {
      throw new Error(`${label} needs a raw backup and review before it can be changed.`);
    }
    const names = new Set();
    for (const line of lines) {
      const match = /^([^:]{1,64}):\s*(#[0-9a-f]{6})$/i.exec(line);
      const name = match && match[1].trim();
      if (!match || !name || hasControlCharacters(name)) {
        throw new Error(`${label} needs a raw backup and review before it can be changed.`);
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
      throw new Error(`${label} needs a raw backup and review before it can be changed.`);
    }
    const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length || lines.length > 128 ||
        lines.some((line) => line.length > 120 || hasControlCharacters(line))) {
      throw new Error(`${label} needs a raw backup and review before it can be changed.`);
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
        'Local color and position configuration needs a raw backup and review before it can be changed.'
      );
    }
    return canonicalConfiguration(value);
  };

  const readConfiguration = () => readConfigurationFromSnapshot(captureRaw(CONFIGURATION_KEYS));

  const listNameValid = (name) =>
    typeof name === 'string' && name === name.trim() && name.length >= 1 &&
    name.length <= 80 && !hasControlCharacters(name) && !RESERVED_KEYS.has(name);

  const validateNamedList = (candidate) => {
    if (!exactKeys(candidate, [
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

  const namedListFromStoredValue = (name, candidate) => {
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

  const namedListToStoredValue = (candidate) => {
    const canonical = canonicalNamedList(candidate);
    const percentages = Object.create(null);
    for (const [name, value] of safeEntries(canonical.colorPercentages)) {
      percentages[name] = value;
    }
    return {
      colors: canonical.colors,
      positions: canonical.positions,
      hiddenColors: canonical.hiddenColors.slice(),
      colorPercentages: percentages,
    };
  };

  const readNamedListsFromRaw = (raw) => {
    if (raw === null) return Object.create(null);
    const parsed = safeJsonParse(raw, 'Saved list data');
    const entries = safeEntries(parsed);
    if (!entries || entries.length > 128) {
      throw new Error('Local saved list data needs a raw backup and review before it can be changed.');
    }
    const result = Object.create(null);
    for (const [name, value] of entries) {
      const namedList = namedListFromStoredValue(name, value);
      if (!listNameValid(name) || !namedList || !validateNamedList(namedList)) {
        throw new Error(`Local saved list ${name || '(unnamed)'} needs a raw backup and review.`);
      }
      result[name] = namedListToStoredValue(namedList);
    }
    return result;
  };

  const readNamedLists = () => readNamedListsFromRaw(window.localStorage.getItem(STORAGE_KEYS.namedLists));

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
      throw new Error('Local scoreboard data needs a raw backup and review before it can be changed.');
    }
    return canonicalScoreboard(value);
  };

  const readScoreboard = () => readScoreboardFromRaw(window.localStorage.getItem(STORAGE_KEYS.scores));

  const validateSound = (candidate) => {
    if (!exactKeys(candidate, ['version', 'enabled'])) return false;
    const entries = Object.fromEntries(safeEntries(candidate));
    return entries.version === SCHEMA_VERSION && typeof entries.enabled === 'boolean';
  };

  const readSoundFromRaw = (raw) => {
    if (raw === null) return undefined;
    if (!['on', 'off'].includes(raw)) {
      throw new Error('Local sound preference needs a raw backup and review before it can be changed.');
    }
    return { version: SCHEMA_VERSION, enabled: raw === 'on' };
  };

  const readSound = () => readSoundFromRaw(window.localStorage.getItem(STORAGE_KEYS.sound));

  const localSave = (task) => Promise.resolve().then(task);

  const saveConfiguration = (candidate) => localSave(() => {
    if (!validateConfiguration(candidate)) {
      throw new Error('The color and position configuration is invalid.');
    }
    const value = canonicalConfiguration(candidate);
    const snapshot = captureRaw(CONFIGURATION_KEYS);
    readConfigurationFromSnapshot(snapshot);
    compareAndSet(snapshot, [
      { key: STORAGE_KEYS.colors, raw: value.colorsText },
      { key: STORAGE_KEYS.positions, raw: value.positionsText },
      { key: STORAGE_KEYS.hiddenColors, raw: JSON.stringify(value.hiddenColors) },
      { key: STORAGE_KEYS.colorPercentages, raw: JSON.stringify(value.colorPercentages) },
    ], 'Color and position configuration');
    return true;
  });

  const resetConfiguration = () => saveConfiguration({
    version: SCHEMA_VERSION,
    colorsText: null,
    positionsText: null,
    hiddenColors: [],
    colorPercentages: Object.create(null),
  });

  const saveNamedList = (candidate) => localSave(() => {
    if (!validateNamedList(candidate)) throw new Error('The saved list is invalid.');
    const value = canonicalNamedList(candidate);
    const snapshot = captureRaw([STORAGE_KEYS.namedLists]);
    const namedLists = readNamedListsFromRaw(snapshot[0].raw);
    namedLists[value.name] = namedListToStoredValue(value);
    compareAndSet(snapshot, [{
      key: STORAGE_KEYS.namedLists,
      raw: JSON.stringify(namedLists),
    }], 'Saved list data');
    return true;
  });

  const removeNamedList = (name) => localSave(() => {
    if (!listNameValid(name)) throw new Error('The saved list name is invalid.');
    const snapshot = captureRaw([STORAGE_KEYS.namedLists]);
    const namedLists = readNamedListsFromRaw(snapshot[0].raw);
    if (!Object.prototype.hasOwnProperty.call(namedLists, name)) return true;
    delete namedLists[name];
    compareAndSet(snapshot, [{
      key: STORAGE_KEYS.namedLists,
      raw: JSON.stringify(namedLists),
    }], 'Saved list data');
    return true;
  });

  const saveScoreboard = (players) => localSave(() => {
    const value = { version: SCHEMA_VERSION, players };
    if (!validateScoreboard(value)) throw new Error('The scoreboard is invalid.');
    const canonical = canonicalScoreboard(value);
    const snapshot = captureRaw([STORAGE_KEYS.scores]);
    readScoreboardFromRaw(snapshot[0].raw);
    compareAndSet(snapshot, [{
      key: STORAGE_KEYS.scores,
      raw: JSON.stringify(canonical.players),
    }], 'Scoreboard data');
    return true;
  });

  const saveSound = (enabled) => localSave(() => {
    const value = { version: SCHEMA_VERSION, enabled };
    if (!validateSound(value)) throw new Error('The sound preference is invalid.');
    const snapshot = captureRaw([STORAGE_KEYS.sound]);
    readSoundFromRaw(snapshot[0].raw);
    compareAndSet(snapshot, [{
      key: STORAGE_KEYS.sound,
      raw: enabled ? 'on' : 'off',
    }], 'Sound preference');
    return true;
  });

  const readNamedListsForDisplay = () => {
    try {
      return readNamedLists();
    } catch (_error) {
      return Object.create(null);
    }
  };

  const assertOwnedStorageValid = () => {
    readConfiguration();
    readNamedLists();
    readScoreboard();
    readSound();
    return true;
  };

  window.ColorGameStorage = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    storageKeys: STORAGE_KEYS,
    readNamedListsForDisplay,
    assertOwnedStorageValid,
    saveConfiguration,
    resetConfiguration,
    saveNamedList,
    removeNamedList,
    saveScoreboard,
    saveSound,
  });
})();
