import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function workerModule() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  return import(workerUrl.href);
}

function fakeDatabase({ legacyRows = [] } = {}) {
  const rows = new Map(legacyRows.map((row) => [
    [row.owner_id, row.app_id, row.collection_name, row.record_id].join("\u001f"),
    row,
  ]));
  const calls = { writes: 0 };
  return {
    calls,
    async batch() { return []; },
    prepare(sql) {
      let values = [];
      return {
        bind(...nextValues) {
          values = nextValues;
          return this;
        },
        async run() {
          if (sql.includes("app_sync_records")) calls.writes += 1;
          return { meta: { changes: 0 } };
        },
        async first() {
          const [ownerId, appId, collectionName, recordId] = values;
          return rows.get([ownerId, appId, collectionName, recordId].join("\u001f")) ?? null;
        },
        async all() {
          const [ownerId, appId, collectionName] = values;
          return {
            results: [...rows.values()].filter((row) => (
              row.owner_id === ownerId && row.app_id === appId && row.collection_name === collectionName
            )),
          };
        },
      };
    },
  };
}

function testEnvironment(db = fakeDatabase()) {
  return {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    DB: db,
    IMAGES: { input() { throw new Error("Image optimization is not used in this test."); } },
  };
}

test("server-renders the Color Game iframe with private install metadata", async () => {
  const { default: worker } = await workerModule();
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    testEnvironment(),
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Color Game<\/title>/i);
  assert.match(html, /<iframe[^>]+title="Color Game"[^>]+src="\/color-game\.html"/i);
  assert.match(html, /site\.webmanifest/);
  assert.match(html, /favicon-32\.png/);
  assert.match(html, /icon-180\.png/);
});

test("ships temporary transfer controls, semantic sync, and the established install artwork", async () => {
  const [html, manifest] = await Promise.all([
    readFile(new URL("../public/color-game.html", import.meta.url), "utf8"),
    readFile(new URL("../public/site.webmanifest", import.meta.url), "utf8"),
  ]);
  assert.match(html, /color-game-storage\.js/);
  assert.match(html, /temporary-data-transfer\.js/);
  assert.match(html, /private-semantic-sync\.js/);
  assert.match(html, /apple-touch-icon[^>]+icon-180\.png/);
  assert.match(html, /ColorGameStorage\.saveConfiguration/);
  assert.match(html, /ColorGameStorage\.saveScoreboard/);
  assert.match(html, /ColorGameStorage\.saveNamedList/);
  assert.doesNotMatch(html, /icons\/color-game-icon\.png/);
  const parsedManifest = JSON.parse(manifest);
  assert.equal(parsedManifest.display, "standalone");
  assert.deepEqual(parsedManifest.icons.map((icon) => icon.sizes), ["192x192", "512x512"]);
  for (const icon of ["favicon-32.png", "icon-180.png", "icon-192.png", "icon-512.png", "icon.png"]) {
    const bytes = await readFile(new URL(`../public/${icon}`, import.meta.url));
    assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
  }
  const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  inlineScripts.forEach((script) => assert.doesNotThrow(() => new Function(script[1])));
});

test("normalizes an existing three-field target saved list before semantic sync", async () => {
  const source = await readFile(new URL("../public/color-game-storage.js", import.meta.url), "utf8");
  const values = new Map([[
    "colorPositionNamedLists",
    JSON.stringify({ Warmup: { colors: "Red: #f34a3d", positions: "Hollow Hold", hiddenColors: [] } }),
  ]]);
  const windowRef = {
    localStorage: {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    navigator: { locks: { request: async (_name, _options, task) => task() } },
    dispatchEvent() {},
  };
  const context = vm.createContext({
    window: windowRef,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    TextEncoder,
  });
  new vm.Script(source, { filename: "color-game-storage.js" }).runInContext(context);
  const lists = windowRef.ColorGameStorage.readNamedListsForDisplay();
  assert.deepEqual(JSON.parse(JSON.stringify(lists.Warmup)), {
    colors: "Red: #f34a3d",
    positions: "Hollow Hold",
    hiddenColors: [],
    colorPercentages: {},
  });
});

test("keeps retained legacy browser-storage owner-readable for recovery and rejects writes", async () => {
  const { default: worker } = await workerModule();
  const db = fakeDatabase({
    legacyRows: [{
      owner_id: "owner-1",
      app_id: "color-game",
      collection_name: "browser-storage",
      record_id: "colorPositionScores",
      revision: 3,
      payload_json: JSON.stringify({ present: true, encoding: "json", value: [{ name: "Player 1", points: 4 }] }),
      updated_at: "2026-08-05T00:00:00.000Z",
    }],
  });
  const context = { waitUntil() {}, passThroughOnException() {} };
  const recoveryUrl = "http://localhost/api/app-sync?appId=color-game&collection=legacy-browser-storage";
  const denied = await worker.fetch(new Request(recoveryUrl), testEnvironment(db), context);
  assert.equal(denied.status, 401);

  const recovered = await worker.fetch(new Request(recoveryUrl, {
    headers: { "oai-authenticated-user-id": "owner-1" },
  }), testEnvironment(db), context);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).records[0].recordId, "colorPositionScores");

  const rejected = await worker.fetch(new Request("http://localhost/api/app-sync", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      "oai-authenticated-user-id": "owner-1",
    },
    body: JSON.stringify({
      version: 1,
      appId: "color-game",
      collection: "legacy-browser-storage",
      recordId: "colorPositionScores",
      expectedRevision: 3,
      value: { schemaVersion: 1, deleted: false, value: [] },
    }),
  }), testEnvironment(db), context);
  assert.equal(rejected.status, 400);
  assert.equal(db.calls.writes, 0);
});
