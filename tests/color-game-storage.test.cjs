const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const storageSource = fs.readFileSync(
  path.join(__dirname, '..', 'color-game-storage.js'),
  'utf8',
);

class FakeLocalStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  }

  getItem(key) {
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

function loadStorage(initial = {}) {
  const localStorage = new FakeLocalStorage(initial);
  const window = { localStorage };
  const context = vm.createContext({ window });
  vm.runInContext(storageSource, context, { filename: 'color-game-storage.js' });
  const realm = (value) => {
    context.__json = JSON.stringify(value);
    return vm.runInContext('JSON.parse(__json)', context);
  };
  return { api: window.ColorGameStorage, localStorage, realm };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

const configuration = (overrides = {}) => ({
  version: 1,
  colorsText: 'Red: #ff0000\nBlue: #0000ff',
  positionsText: 'Hollow Hold\nArch Hold',
  hiddenColors: [],
  colorPercentages: { red: 50, blue: 50 },
  ...overrides,
});

const namedList = (name = 'Warmup') => ({
  version: 1,
  name,
  colors: 'Red: #ff0000\nBlue: #0000ff',
  positions: 'Hollow Hold\nArch Hold',
  hiddenColors: [],
  colorPercentages: { red: 50, blue: 50 },
});

test('keeps Color Game settings, saved lists, scores, and sound on this device', async () => {
  const environment = loadStorage({ unrelated: 'preserve me' });

  await environment.api.saveConfiguration(environment.realm(configuration()));
  await environment.api.saveNamedList(environment.realm(namedList()));
  await environment.api.saveScoreboard(environment.realm([{ name: 'Player 1', points: 3 }]));
  await environment.api.saveSound(false);

  assert.equal(environment.localStorage.getItem('colorPositionColors'), 'Red: #ff0000\nBlue: #0000ff');
  assert.equal(environment.localStorage.getItem('colorPositionPositions'), 'Hollow Hold\nArch Hold');
  assert.deepEqual(plain(environment.api.readNamedListsForDisplay()), {
    Warmup: {
      colors: 'Red: #ff0000\nBlue: #0000ff',
      positions: 'Hollow Hold\nArch Hold',
      hiddenColors: [],
      colorPercentages: { red: 50, blue: 50 },
    },
  });
  assert.deepEqual(
    JSON.parse(environment.localStorage.getItem('colorPositionScores')),
    [{ name: 'Player 1', points: 3 }],
  );
  assert.equal(environment.localStorage.getItem('colorPositionSound'), 'off');
  assert.equal(environment.localStorage.getItem('unrelated'), 'preserve me');
});

test('removes only the requested local saved list and restores default settings', async () => {
  const environment = loadStorage();
  await environment.api.saveNamedList(environment.realm(namedList('Warmup')));
  await environment.api.saveNamedList(environment.realm(namedList('Strength')));
  await environment.api.removeNamedList('Warmup');
  await environment.api.resetConfiguration();

  assert.deepEqual(Object.keys(plain(environment.api.readNamedListsForDisplay())), ['Strength']);
  assert.equal(environment.localStorage.getItem('colorPositionColors'), null);
  assert.equal(environment.localStorage.getItem('colorPositionPositions'), null);
  assert.equal(environment.localStorage.getItem('colorPositionHiddenColors'), '[]');
  assert.equal(environment.localStorage.getItem('colorPositionColorPercentages'), '{}');
});

test('preserves malformed local bytes instead of overwriting them', async () => {
  const environment = loadStorage({ colorPositionNamedLists: '{bad' });
  const before = environment.localStorage.snapshot();

  await assert.rejects(
    environment.api.saveNamedList(environment.realm(namedList())),
    /raw backup and review/,
  );

  assert.deepEqual(environment.localStorage.snapshot(), before);
});

test('does not expose retired remote-sync adapter APIs', () => {
  const environment = loadStorage();
  for (const key of [
    'appId', 'changeEvent', 'aggregateLock', 'makeAdapters', 'attachHandles',
    'listRecordId', 'setEditorState',
  ]) {
    assert.equal(environment.api[key], undefined, `${key} should not ship`);
  }
});
