const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const root = resolve(__dirname, "..");

test("the automatic record sync client ships without controls or transfer UI", () => {
  const index = readFileSync(resolve(root, "index.html"), "utf8");
  const runtime = readFileSync(resolve(root, "automatic-app-sync.js"), "utf8");
  const legacyAssets = readFileSync(resolve(root, "scripts", "prepare-legacy-assets.mjs"), "utf8");
  const retiredTransferAsset = ["temporary", "data", "transfer.js"].join("-");
  const retiredTransferLabel = ["Transfer", "data"].join(" ");
  const retiredPrivateSemantic = ["private", "semantic", "sync"].join(" ");

  assert.equal(existsSync(resolve(root, "automatic-app-sync.js")), true);
  assert.equal(existsSync(resolve(root, retiredTransferAsset)), false);
  assert.match(index, /<script src="automatic-app-sync\.js" data-app-id="/);
  assert.match(legacyAssets, /automatic-app-sync\.js/);
  const retiredPanel = ["private", "sync", "panel"].join("-");
  const retiredDataAttribute = ["data", "private", "sync", "panel"].join("-");
  assert.doesNotMatch(index, new RegExp(`data-(?:enable-)?sync|${retiredDataAttribute}|${retiredTransferLabel}`, "i"));
  assert.doesNotMatch(
    runtime,
    new RegExp(`${retiredPanel}|${retiredPrivateSemantic}|data-(?:enable-)?sync|createElement\\(|Download both|Keep this device|Use synced record`, "i"),
  );
  assert.match(runtime, /RECOVERY_PREFIX/);
  assert.match(runtime, /windowRef\.addEventListener\("online", schedule\)/);
  assert.match(runtime, /windowRef\.addEventListener\("focus", schedule\)/);
});
