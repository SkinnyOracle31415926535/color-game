const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");

const layout = readFileSync(new URL("../app/layout.tsx", `file://${__filename}`), "utf8");

test("declares each staged Color Game install icon and web-app metadata", () => {
  assert.match(layout, /applicationName: "Color Game"/);
  assert.match(layout, /themeColor: "#0033ff"/);
  for (const [path, size] of [
    ["/legacy/favicon-32.png", "32x32"],
    ["/legacy/icon-192.png", "192x192"],
    ["/legacy/icon-512.png", "512x512"],
  ]) {
    assert.match(layout, new RegExp(`url: "${path.replaceAll(".", "\\.")}", sizes: "${size}"`));
  }
  assert.match(layout, /shortcut: "\/legacy\/favicon-32\.png"/);
  assert.match(layout, /apple: \[\{ url: "\/legacy\/icon-180\.png", sizes: "180x180"/);
  assert.match(layout, /other: \{[\s\S]*"apple-mobile-web-app-capable": "yes"/);
  assert.match(layout, /appleWebApp: \{[\s\S]*capable: true/);
});
