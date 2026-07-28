const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'color-game-sync.js'),
  'utf8',
);

function loadPolicy() {
  const window = { ColorGameStorage: {} };
  const document = {
    body: null,
    querySelector() {
      return null;
    },
  };
  const context = vm.createContext({ window, document });
  vm.runInContext(source, context, { filename: 'color-game-sync.js' });
  return window.ColorGameSyncPolicy;
}

test('migration apply is allowed only for a zero-write, empty-remote, empty-orphan preview', () => {
  const policy = loadPolicy();
  const safe = { writesPerformed: 0, remoteCount: 0, orphanedCount: 0 };
  assert.equal(policy.migrationGate(safe).safe, true);
  assert.equal(policy.requireSafeMigration(safe), true);
});

for (const [name, preview, pattern] of [
  ['preview writes', { writesPerformed: 1, remoteCount: 0, orphanedCount: 0 }, /performed writes/],
  ['remote records', { writesPerformed: 0, remoteCount: 1, orphanedCount: 0 }, /remote record/],
  ['orphaned intents', { writesPerformed: 0, remoteCount: 0, orphanedCount: 1 }, /orphaned/],
  ['missing counts', { writesPerformed: 0, remoteCount: 0 }, /counts are invalid/],
  ['negative counts', { writesPerformed: 0, remoteCount: -1, orphanedCount: 0 }, /counts are invalid/],
]) {
  test(`migration apply hard-blocks ${name}`, () => {
    const policy = loadPolicy();
    const gate = policy.migrationGate(preview);
    assert.equal(gate.safe, false);
    assert.match(gate.message, pattern);
    assert.throws(() => policy.requireSafeMigration(preview), pattern);
  });
}

test('the visible gate and apply handler both call the shared hard-block policy', () => {
  assert.match(
    source,
    /const gate = migrationGate\(previewResult\.preview\);[\s\S]*applyButton\.disabled = !gate\.safe/,
  );
  assert.match(
    source,
    /requireSafeMigration\(previewResult\.preview\);[\s\S]*client\.applyMigration/,
  );
});
