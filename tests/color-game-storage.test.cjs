const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const storageSource = fs.readFileSync(
  path.join(__dirname, '..', 'color-game-storage.js'),
  'utf8',
);

class FakeLocalStorage {
  constructor(initial = {}) {
    this.values = new Map(
      Object.entries(initial).map(([key, value]) => [key, String(value)]),
    );
    this.reads = [];
  }

  getItem(key) {
    this.reads.push(String(key));
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }

  snapshot() {
    return Object.fromEntries(this.values);
  }
}

class FakeLocks {
  constructor() {
    this.calls = [];
    this.tail = Promise.resolve();
  }

  request(name, options, task) {
    this.calls.push({ name, options: { ...options } });
    const result = this.tail.then(task);
    this.tail = result.catch(() => {});
    return result;
  }
}

class FakeCustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
}

function loadStorage(initial = {}, options = {}) {
  const localStorage = new FakeLocalStorage(initial);
  const locks = new FakeLocks();
  const events = [];
  const subtle = options.digest
    ? { digest: options.digest }
    : crypto.webcrypto.subtle;
  const window = {
    localStorage,
    navigator: { locks },
    crypto: { subtle },
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
  };
  const context = vm.createContext({
    window,
    CustomEvent: FakeCustomEvent,
    TextEncoder,
    Uint8Array,
  });
  vm.runInContext(storageSource, context, { filename: 'color-game-storage.js' });
  return {
    api: window.ColorGameStorage,
    context,
    events,
    localStorage,
    locks,
    window,
  };
}

function inRealm(environment, value) {
  environment.context.__json = JSON.stringify(value);
  return vm.runInContext('JSON.parse(__json)', environment.context);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function validConfiguration(overrides = {}) {
  return {
    version: 1,
    colorsText: 'Red: #ff0000\nBlue: #0000ff',
    positionsText: 'Hollow Hold\nArch Hold',
    hiddenColors: [],
    colorPercentages: { red: 50, blue: 50 },
    ...overrides,
  };
}

function validList(name = 'Warmup', overrides = {}) {
  return {
    version: 1,
    name,
    colors: 'Red: #ff0000\nBlue: #0000ff',
    positions: 'Hollow Hold\nArch Hold',
    hiddenColors: [],
    colorPercentages: { red: 50, blue: 50 },
    ...overrides,
  };
}

function validLegacyList(overrides = {}) {
  const { version, name, ...legacy } = validList('Unused', overrides);
  return legacy;
}

function validScoreboard(points = 0) {
  return {
    version: 1,
    players: [{ name: 'Player 1', points }],
  };
}

function shaRecordId(name) {
  return `list-${crypto.createHash('sha256').update(name, 'utf8').digest('hex')}`;
}

function remoteMetadata(deleted = false) {
  return { source: 'remote', deleted };
}

function localMetadata(deleted = false) {
  return { source: 'local', deleted };
}

test('registers exactly three fixed records and one app-owned saved-list collection', () => {
  const environment = loadStorage();
  const adapters = environment.api.makeAdapters();
  assert.deepEqual(Object.keys(adapters), [
    'configuration', 'savedLists', 'scoreboard', 'sound',
  ]);
  assert.deepEqual(
    [
      [adapters.configuration.collection, adapters.configuration.recordId],
      [adapters.savedLists.collection, adapters.savedLists.recordId],
      [adapters.scoreboard.collection, adapters.scoreboard.recordId],
      [adapters.sound.collection, adapters.sound.recordId],
    ],
    [
      ['configuration', 'current'],
      ['saved-lists', undefined],
      ['scoreboard', 'current'],
      ['preferences', 'sound'],
    ],
  );
  for (const adapter of Object.values(adapters)) {
    assert.equal(adapter.scope, 'color-game');
    assert.equal(adapter.appId, 'color-game');
    assert.equal(adapter.schemaVersion, 1);
  }
  assert.equal(JSON.stringify(adapters).includes('theme'), false);
  assert.equal(JSON.stringify(adapters).includes('difficulty'), false);
});

test('raw backup contains the exact seven owned keys in order and preserves raw bytes', () => {
  const initial = {
    colorPositionColors: 'Red: #ff0000\r\nBlue: #0000ff',
    colorPositionPositions: '',
    colorPositionHiddenColors: '{bad-json',
    colorPositionColorPercentages: '{"red":50.000}',
    colorPositionNamedLists: '{"raw":"bytes"}',
    colorPositionScores: '[{"name":"A","points":0}]',
    colorPositionSound: 'unexpected',
    unrelatedAppKey: 'must-not-be-read',
  };
  const environment = loadStorage(initial);
  const backup = environment.api.rawBackup();
  assert.deepEqual(
    plain(backup.records.map(({ key }) => key)),
    [
      'colorPositionColors',
      'colorPositionPositions',
      'colorPositionHiddenColors',
      'colorPositionColorPercentages',
      'colorPositionNamedLists',
      'colorPositionScores',
      'colorPositionSound',
    ],
  );
  assert.equal(backup.records.length, 7);
  assert.deepEqual(environment.localStorage.reads, plain(environment.api.rawBackupKeys));
  for (const record of backup.records) {
    assert.equal(record.present, true);
    assert.equal(record.raw_value, initial[record.key]);
  }
  assert.equal(backup.records.some(({ key }) => key === 'unrelatedAppKey'), false);
});

test('temporary transfer snapshots validate before replacing only owned Color Game keys', async () => {
  const environment = loadStorage({
    colorPositionColors: 'Red: #ff0000',
    colorPositionPositions: 'Hollow Hold',
    colorPositionHiddenColors: '[]',
    colorPositionColorPercentages: '{"red":100}',
    colorPositionNamedLists: JSON.stringify({ Warmup: validLegacyList() }),
    colorPositionScores: '[{"name":"A","points":1}]',
    colorPositionSound: 'on',
    unrelatedAppKey: 'preserved',
  });
  const snapshot = environment.api.transferSnapshot();
  assert.equal(environment.api.validateTransferSnapshot(snapshot), true);
  const incoming = inRealm(environment, {
    ...plain(snapshot),
    scoreboard: validScoreboard(42),
    sound: { version: 1, enabled: false },
  });

  await environment.api.applyTransferSnapshot(incoming);

  assert.equal(JSON.parse(environment.localStorage.getItem('colorPositionScores'))[0].points, 42);
  assert.equal(environment.localStorage.getItem('colorPositionSound'), 'off');
  assert.equal(environment.localStorage.getItem('unrelatedAppKey'), 'preserved');
  assert.deepEqual(
    environment.events.map((event) => event.detail.source),
    ['migration', 'migration', 'migration', 'migration'],
  );

  const before = environment.localStorage.snapshot();
  await assert.rejects(
    environment.api.applyTransferSnapshot(inRealm(environment, {
      configuration: null,
      named_lists: [],
      scoreboard: null,
      sound: null,
    })),
    /transfer file is invalid/,
  );
  assert.deepEqual(environment.localStorage.snapshot(), before);
});

test('malformed existing aggregates fail closed and retain every raw byte', async (t) => {
  const cases = [
    {
      name: 'configuration',
      initial: {
        colorPositionColors: 'Red: #ff0000',
        colorPositionPositions: 'Hollow Hold',
        colorPositionHiddenColors: '{bad',
        colorPositionColorPercentages: '{"red":100}',
      },
      mutate: (environment) =>
        environment.api.saveConfiguration(inRealm(environment, validConfiguration({
          colorsText: 'Red: #ff0000',
          positionsText: 'Hollow Hold',
          colorPercentages: { red: 100 },
        }))),
    },
    {
      name: 'saved lists',
      initial: { colorPositionNamedLists: '{"broken":' },
      mutate: (environment) =>
        environment.api.saveNamedList(inRealm(environment, validList())),
    },
    {
      name: 'scoreboard',
      initial: { colorPositionScores: '[{"name":"A","points":"bad"}]' },
      mutate: (environment) =>
        environment.api.saveScoreboard(inRealm(environment, validScoreboard(1)).players),
    },
    {
      name: 'sound',
      initial: { colorPositionSound: 'maybe' },
      mutate: (environment) => environment.api.saveSound(false),
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const environment = loadStorage(item.initial);
      const before = environment.localStorage.snapshot();
      assert.throws(
        () => environment.api.assertOwnedStorageValid(),
        /raw backup and review/,
      );
      await assert.rejects(item.mutate(environment), /raw backup and review/);
      assert.deepEqual(environment.localStorage.snapshot(), before);
      assert.equal(environment.events.length, 0);
    });
  }
});

test('validators accept null-prototype data and reject custom prototypes, getters, and pollution', () => {
  const environment = loadStorage();
  environment.context.adapters = environment.api.makeAdapters();

  const result = vm.runInContext(`
    (() => {
      const percentages = Object.create(null);
      percentages.red = 100;
      const valid = Object.create(null);
      valid.version = 1;
      valid.colorsText = "Red: #ff0000";
      valid.positionsText = "Hollow Hold";
      valid.hiddenColors = [];
      valid.colorPercentages = percentages;

      const custom = Object.create({ inherited: true });
      Object.assign(custom, valid);

      let getterCalls = 0;
      const getter = Object.create(null);
      getter.version = 1;
      Object.defineProperty(getter, "colorsText", {
        enumerable: true,
        get() { getterCalls += 1; return "Red: #ff0000"; }
      });
      getter.positionsText = "Hollow Hold";
      getter.hiddenColors = [];
      getter.colorPercentages = percentages;

      const pollutedPercentages = Object.create(null);
      pollutedPercentages.__proto__ = 100;
      const polluted = Object.create(null);
      polluted.version = 1;
      polluted.colorsText = "Red: #ff0000";
      polluted.positionsText = "Hollow Hold";
      polluted.hiddenColors = [];
      polluted.colorPercentages = pollutedPercentages;

      return {
        valid: adapters.configuration.validate(valid),
        custom: adapters.configuration.validate(custom),
        getter: adapters.configuration.validate(getter),
        getterCalls,
        polluted: adapters.configuration.validate(polluted),
      };
    })()
  `, environment.context);

  assert.deepEqual(plain(result), {
    valid: true,
    custom: false,
    getter: false,
    getterCalls: 0,
    polluted: false,
  });

  environment.localStorage.setItem(
    'colorPositionNamedLists',
    `{"__proto__":${JSON.stringify(validLegacyList())}}`,
  );
  assert.throws(
    () => environment.api.assertOwnedStorageValid(),
    /saved list __proto__/i,
  );
});

test('fixed records reject local and remote tombstones without changing local data', async (t) => {
  const cases = [
    {
      name: 'configuration',
      seed: {
        colorPositionColors: 'Red: #ff0000',
        colorPositionPositions: 'Hollow Hold',
        colorPositionHiddenColors: '[]',
        colorPositionColorPercentages: '{"red":100}',
      },
      adapter: 'configuration',
    },
    {
      name: 'scoreboard',
      seed: { colorPositionScores: '[{"name":"Player 1","points":2}]' },
      adapter: 'scoreboard',
    },
    {
      name: 'sound',
      seed: { colorPositionSound: 'on' },
      adapter: 'sound',
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const environment = loadStorage(item.seed);
      const adapter = environment.api.makeAdapters()[item.adapter];
      const before = environment.localStorage.snapshot();
      await assert.rejects(
        Promise.resolve().then(() => adapter.writeLocal(null, localMetadata(true))),
        /fixed record and cannot be deleted/,
      );
      assert.deepEqual(environment.localStorage.snapshot(), before);
      await assert.rejects(
        Promise.resolve().then(() => adapter.applyRemote(null, remoteMetadata(true))),
        /fixed record and cannot be deleted/,
      );
      assert.deepEqual(environment.localStorage.snapshot(), before);
      assert.equal(environment.events.length, 0);
    });
  }
});

test('Defaults writes an explicit fixed configuration instead of a tombstone', async () => {
  const environment = loadStorage({
    colorPositionColors: 'Red: #ff0000',
    colorPositionPositions: 'Hollow Hold',
    colorPositionHiddenColors: '[]',
    colorPositionColorPercentages: '{"red":100}',
  });
  await environment.api.resetConfiguration();
  assert.equal(environment.localStorage.getItem('colorPositionColors'), null);
  assert.equal(environment.localStorage.getItem('colorPositionPositions'), null);
  assert.equal(environment.localStorage.getItem('colorPositionHiddenColors'), '[]');
  assert.equal(environment.localStorage.getItem('colorPositionColorPercentages'), '{}');
  const value = await environment.api.makeAdapters().configuration.readLocal();
  assert.deepEqual(plain(value), {
    version: 1,
    colorsText: null,
    positionsText: null,
    hiddenColors: [],
    colorPercentages: {},
  });
});

test('every adapter RMW uses the same exclusive aggregate lock', async () => {
  const environment = loadStorage();
  const adapters = environment.api.makeAdapters();
  const configuration = inRealm(environment, validConfiguration());
  const scoreboard = inRealm(environment, validScoreboard(3));
  const sound = inRealm(environment, { version: 1, enabled: false });
  const list = inRealm(environment, validList('Warmup'));
  const listId = await environment.api.listRecordId('Warmup');

  await adapters.configuration.applyRemote(configuration, remoteMetadata());
  await adapters.savedLists.applyRemote(listId, list, remoteMetadata());
  await adapters.scoreboard.applyRemote(scoreboard, remoteMetadata());
  await adapters.sound.applyRemote(sound, remoteMetadata());

  assert.ok(environment.locks.calls.length >= 4);
  assert.deepEqual(
    [...new Set(environment.locks.calls.map(({ name }) => name))],
    [environment.api.aggregateLock],
  );
  assert.ok(environment.locks.calls.every(({ options }) => options.mode === 'exclusive'));
});

test('missing shared browser locks fails closed without writing', async () => {
  const environment = loadStorage();
  delete environment.window.navigator.locks;
  const before = environment.localStorage.snapshot();
  await assert.rejects(
    environment.api.saveSound(false),
    /Shared browser locking is unavailable/,
  );
  assert.deepEqual(environment.localStorage.snapshot(), before);
  assert.equal(environment.events.length, 0);
});

test('raw CAS preserves a newer non-cooperative saved-list write', async () => {
  let releaseDigest;
  let digestStarted;
  const started = new Promise((resolve) => { digestStarted = resolve; });
  const release = new Promise((resolve) => { releaseDigest = resolve; });
  let delayed = true;
  const digest = async (...args) => {
    if (delayed) {
      delayed = false;
      digestStarted();
      await release;
    }
    return crypto.webcrypto.subtle.digest(...args);
  };
  const environment = loadStorage({}, { digest });
  const adapter = environment.api.makeAdapters().savedLists;
  const remote = inRealm(environment, validList('Remote'));
  const remoteId = shaRecordId('Remote');
  const applying = adapter.applyRemote(remoteId, remote, remoteMetadata());

  await started;
  const newerRaw = JSON.stringify({ Newer: validLegacyList() });
  environment.localStorage.setItem('colorPositionNamedLists', newerRaw);
  releaseDigest();

  await assert.rejects(applying, /changed during an atomic update/);
  assert.equal(environment.localStorage.getItem('colorPositionNamedLists'), newerRaw);
  assert.equal(environment.events.length, 0);
});

test('a newer synchronous local generation defeats an in-flight remote callback', async () => {
  let releaseDigest;
  let digestStarted;
  const started = new Promise((resolve) => { digestStarted = resolve; });
  const release = new Promise((resolve) => { releaseDigest = resolve; });
  let delayed = true;
  const digest = async (...args) => {
    if (delayed) {
      delayed = false;
      digestStarted();
      await release;
    }
    return crypto.webcrypto.subtle.digest(...args);
  };
  const environment = loadStorage({}, { digest });
  const adapter = environment.api.makeAdapters().savedLists;
  const remote = inRealm(environment, validList('Remote'));
  const local = inRealm(environment, validList('Local'));
  const applying = adapter.applyRemote(
    shaRecordId('Remote'),
    remote,
    remoteMetadata(),
  );

  await started;
  const saving = environment.api.saveNamedList(local);
  releaseDigest();

  await assert.rejects(applying, /newer local edit needs review/);
  await saving;
  const stored = JSON.parse(environment.localStorage.getItem('colorPositionNamedLists'));
  assert.deepEqual(Object.keys(stored), ['Local']);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'Remote'), false);
});

test('rapid fixed-record staging coalesces to the newest value', async () => {
  const environment = loadStorage();
  environment.window.__handleCalls = [];
  vm.runInContext(`
    window.ColorGameStorage.attachHandles({
      configuration: { save(value) { window.__handleCalls.push(["configuration", JSON.stringify(value)]); return Promise.resolve(true); } },
      savedLists: {
        save(recordId, value) { window.__handleCalls.push(["saved-list-save", recordId, JSON.stringify(value)]); return Promise.resolve(true); },
        remove(recordId) { window.__handleCalls.push(["saved-list-remove", recordId]); return Promise.resolve(true); }
      },
      scoreboard: { save(value) { window.__handleCalls.push(["scoreboard", JSON.stringify(value)]); return Promise.resolve(true); } },
      sound: { save(value) { window.__handleCalls.push(["sound", JSON.stringify(value)]); return Promise.resolve(true); } }
    });
  `, environment.context);

  const first = inRealm(environment, validScoreboard(1)).players;
  const second = inRealm(environment, validScoreboard(2)).players;
  const latest = inRealm(environment, validScoreboard(3)).players;
  await Promise.all([
    environment.api.saveScoreboard(first),
    environment.api.saveScoreboard(second),
    environment.api.saveScoreboard(latest),
  ]);

  const calls = environment.window.__handleCalls.filter(([kind]) => kind === 'scoreboard');
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0][1]).players[0].points, 3);
});

test('saved-list staging coalesces the same identity but preserves distinct names', async () => {
  const environment = loadStorage();
  environment.window.__handleCalls = [];
  vm.runInContext(`
    window.ColorGameStorage.attachHandles({
      configuration: { save() { return Promise.resolve(true); } },
      savedLists: {
        save(recordId, value) { window.__handleCalls.push([recordId, JSON.stringify(value)]); return Promise.resolve(true); },
        remove() { return Promise.resolve(true); }
      },
      scoreboard: { save() { return Promise.resolve(true); } },
      sound: { save() { return Promise.resolve(true); } }
    });
  `, environment.context);

  const a1 = inRealm(environment, validList('A', { positions: 'First' }));
  const a2 = inRealm(environment, validList('A', { positions: 'Newest' }));
  const b = inRealm(environment, validList('B'));
  await Promise.all([
    environment.api.saveNamedList(a1),
    environment.api.saveNamedList(a2),
    environment.api.saveNamedList(b),
  ]);

  assert.equal(environment.window.__handleCalls.length, 2);
  const values = environment.window.__handleCalls.map(([, raw]) => JSON.parse(raw));
  assert.equal(values.find(({ name }) => name === 'A').positions, 'Newest');
  assert.ok(values.some(({ name }) => name === 'B'));
});

test('saved-list IDs are stable SHA-256 values and aggregate collisions are rejected', async () => {
  const environment = loadStorage();
  assert.equal(
    await environment.api.listRecordId('Warmup'),
    shaRecordId('Warmup'),
  );
  assert.equal(
    await environment.api.listRecordId('warmup'),
    shaRecordId('warmup'),
  );
  assert.notEqual(
    await environment.api.listRecordId('Warmup'),
    await environment.api.listRecordId('warmup'),
  );

  const collisionDigest = async () => new Uint8Array(32).buffer;
  const collisionEnvironment = loadStorage({
    colorPositionNamedLists: JSON.stringify({
      A: validLegacyList(),
      B: validLegacyList(),
    }),
  }, { digest: collisionDigest });
  await assert.rejects(
    collisionEnvironment.api.makeAdapters().savedLists.listLocal(),
    /identities collide/,
  );
});

test('remote callbacks cannot replace focused edits; local save survives focus then blur', async () => {
  const initialRaw = '[{"name":"Player 1","points":1}]';
  const environment = loadStorage({ colorPositionScores: initialRaw });
  const adapter = environment.api.makeAdapters().scoreboard;
  const remote = inRealm(environment, validScoreboard(99));
  const local = inRealm(environment, validScoreboard(2));

  environment.api.setEditorState('scoreboard', inRealm(environment, { active: true }));
  await assert.rejects(
    Promise.resolve().then(() => adapter.applyRemote(remote, remoteMetadata())),
    /newer local edit needs review/,
  );
  assert.equal(environment.localStorage.getItem('colorPositionScores'), initialRaw);

  await environment.api.saveScoreboard(local.players);
  environment.api.setEditorState('scoreboard', inRealm(environment, { active: false }));
  assert.equal(
    environment.localStorage.getItem('colorPositionScores'),
    '[{"name":"Player 1","points":2}]',
  );
  assert.equal(
    environment.events.filter(({ detail }) => detail.source === 'remote').length,
    0,
  );
});

test('dirty configuration remains protected after blur until an explicit local save settles', async () => {
  const environment = loadStorage({
    colorPositionColors: 'Red: #ff0000',
    colorPositionPositions: 'Original',
    colorPositionHiddenColors: '[]',
    colorPositionColorPercentages: '{"red":100}',
  });
  const adapter = environment.api.makeAdapters().configuration;
  const remote = inRealm(environment, validConfiguration({
    colorsText: 'Red: #ff0000',
    positionsText: 'Remote',
    colorPercentages: { red: 100 },
  }));
  environment.api.setEditorState(
    'configuration',
    inRealm(environment, { active: true, dirty: true }),
  );
  environment.api.setEditorState(
    'configuration',
    inRealm(environment, { active: false }),
  );

  await assert.rejects(
    Promise.resolve().then(() => adapter.applyRemote(remote, remoteMetadata())),
    /newer local edit needs review/,
  );
  assert.equal(environment.localStorage.getItem('colorPositionPositions'), 'Original');

  const local = inRealm(environment, validConfiguration({
    colorsText: 'Red: #ff0000',
    positionsText: 'Local after blur',
    colorPercentages: { red: 100 },
  }));
  await environment.api.saveConfiguration(local);
  environment.api.setEditorState(
    'configuration',
    inRealm(environment, { dirty: false }),
  );
  assert.equal(
    environment.localStorage.getItem('colorPositionPositions'),
    'Local after blur',
  );
});
