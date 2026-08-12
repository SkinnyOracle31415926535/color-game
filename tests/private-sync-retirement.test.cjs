const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const root = resolve(__dirname, "..");

test("the client no longer ships a private sync panel or runtime", () => {
  const index = readFileSync(resolve(root, "index.html"), "utf8");
  const storage = readFileSync(resolve(root, "color-game-storage.js"), "utf8");
  const legacyAssets = readFileSync(resolve(root, "scripts", "prepare-legacy-assets.mjs"), "utf8");

  assert.equal(existsSync(resolve(root, "private-semantic-sync.js")), false);
  assert.doesNotMatch(index, /private-semantic-sync\.js/);
  assert.doesNotMatch(index, /data-(?:enable-)?sync|data-private-sync-panel/);
  assert.doesNotMatch(index, /\/api\/app-sync/);
  assert.doesNotMatch(legacyAssets, /private-semantic-sync\.js/);
  assert.doesNotMatch(storage, /makeAdapters|attachHandles|applyRemote|listRecordId|setEditorState/);
});
