const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = resolve(__dirname, "..");
const source = readFileSync(resolve(root, "automatic-app-sync.js"), "utf8");
const moduleRef = { exports: {} };
const context = vm.createContext({ module: moduleRef, TextEncoder, URL });
new vm.Script(source, { filename: "automatic-app-sync.js" }).runInContext(context);
const sync = moduleRef.exports;

function localStorageFixture(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function semanticServer() {
  const records = new Map();
  const key = (collection, recordId) => collection + "\u001f" + recordId;
  let beforePut = null;
  const publicRecord = (record) => record && ({
    recordId: record.recordId,
    revision: record.revision,
    value: record.value,
    updatedAt: record.updatedAt,
  });
  const fetch = async (url, options = {}) => {
    const endpoint = new URL(url, "https://private.example");
    if (options.method !== "PUT") {
      const collection = endpoint.searchParams.get("collection");
      const listed = [...records.values()]
        .filter((item) => item.collection === collection)
        .map(({ collection: _collection, ...record }) => record);
      return response({
        version: 1,
        appId: endpoint.searchParams.get("appId"),
        collection,
        records: listed,
      });
    }
    const request = JSON.parse(options.body);
    if (beforePut) {
      const callback = beforePut;
      beforePut = null;
      callback(request, records);
    }
    const recordKey = key(request.collection, request.recordId);
    const current = records.get(recordKey);
    if ((request.expectedRevision === null && current)
      || (request.expectedRevision !== null && (!current || current.revision !== request.expectedRevision))) {
      return response({ error: "conflict", current: publicRecord(current) }, 409);
    }
    const record = {
      collection: request.collection,
      recordId: request.recordId,
      revision: current ? current.revision + 1 : 1,
      value: request.value,
      updatedAt: "2026-08-12T00:00:00.000Z",
    };
    records.set(recordKey, record);
    return response({ record: publicRecord(record) });
  };
  return {
    records,
    fetch,
    key,
    setBeforePut(callback) { beforePut = callback; },
  };
}

function profile(local, applied) {
  return {
    id: "classes",
    collection: "classes",
    owns: (recordId) => /^class-[a-z]+$/.test(recordId),
    validate: (value) => value && typeof value.name === "string",
    readAll: async () => new Map(local),
    writeLocal: async (recordId, value, deleted) => {
      if (deleted) local.delete(recordId);
      else local.set(recordId, value);
    },
    applyRemote: async (recordId, payload) => {
      if (payload.deleted) local.delete(recordId);
      else local.set(recordId, payload.value);
      applied.push(recordId);
    },
  };
}

function windowFixture(appId, server, metadata) {
  const storage = localStorageFixture({
    ["__ryan_semantic_private_sync_" + appId + "_v1"]: JSON.stringify(metadata),
  });
  return {
    localStorage: storage,
    fetch: server.fetch,
    setTimeout() { return 1; },
    setInterval() { return 1; },
    addEventListener() {},
    document: { visibilityState: "visible", addEventListener() {} },
    CustomEvent: class CustomEvent {},
  };
}

test("boots on a hosted app without creating a sync control", () => {
  const events = [];
  let attached = null;
  const server = semanticServer();
  const windowRef = windowFixture("color-game", server, { version: 1, enabled: true, records: {} });
  windowRef.location = { protocol: "https:", hostname: "color-game.chatgpt.site" };
  windowRef.document = {
    currentScript: { dataset: { appId: "color-game" } },
    visibilityState: "visible",
    addEventListener(name) { events.push(name); },
    createElement() { throw new Error("Automatic sync must not create UI elements."); },
  };
  windowRef.addEventListener = (name) => { events.push(name); };
  windowRef.ColorGameStorage = {
    makeAdapters() {
      const fixed = (collection, recordId) => ({
        collection,
        recordId,
        validate: () => true,
        readLocal: async () => undefined,
        writeLocal: async () => {},
        applyRemote: async () => {},
      });
      return {
        configuration: fixed("configuration", "current"),
        savedLists: {
          collection: "saved-lists",
          validate: () => true,
          listLocal: async () => [],
          writeLocal: async () => {},
          applyRemote: async () => {},
        },
        scoreboard: fixed("scoreboard", "current"),
        sound: fixed("preferences", "sound"),
      };
    },
    attachHandles(value) { attached = value; },
  };

  const bootContext = vm.createContext({ TextEncoder, URL, window: windowRef });
  new vm.Script(source, { filename: "automatic-app-sync.js" }).runInContext(bootContext);

  assert.ok(attached);
  assert.equal(typeof attached.configuration.save, "function");
  assert.equal(events.includes("online"), true);
  assert.equal(events.includes("focus"), true);
  assert.equal(events.includes("visibilitychange"), true);
});

test("starts automatically for a device that previously had sync disabled", async () => {
  const appId = "auto-start";
  const server = semanticServer();
  const local = new Map();
  const windowRef = windowFixture(appId, server, { version: 1, enabled: false, records: {} });
  const client = sync.createSemanticSync({
    windowRef,
    appId,
    profiles: [profile(local, [])],
  });

  client.start();
  assert.equal(
    JSON.parse(windowRef.localStorage.getItem("__ryan_semantic_private_sync_" + appId + "_v1")).enabled,
    true,
  );

  await client.localSave("classes", "class-alice", { name: "Alice" }, false);
  await client.reconcile();
  assert.equal(
    JSON.stringify(server.records.get(server.key("classes", "class-alice")).value),
    JSON.stringify(sync.semanticValue({ name: "Alice" }, false)),
  );
});

test("uses the existing server record on first automatic reconciliation and preserves the local copy", async () => {
  const appId = "server-wins";
  const server = semanticServer();
  const remote = sync.semanticValue({ name: "Remote Alice" }, false);
  server.records.set(server.key("classes", "class-alice"), {
    collection: "classes",
    recordId: "class-alice",
    revision: 3,
    value: remote,
    updatedAt: "2026-08-12T00:00:00.000Z",
  });
  const local = new Map([["class-alice", { name: "Local Alice" }]]);
  const applied = [];
  const windowRef = windowFixture(appId, server, { version: 1, enabled: false, records: {} });
  const client = sync.createSemanticSync({
    windowRef,
    appId,
    profiles: [profile(local, applied)],
  });

  client.start();
  await client.reconcile();

  assert.deepEqual(local.get("class-alice"), { name: "Remote Alice" });
  assert.deepEqual(applied, ["class-alice"]);
  const recovery = JSON.parse(windowRef.localStorage.getItem(sync.recoveryKey(appId)));
  assert.equal(recovery.records.length, 1);
  assert.equal(
    JSON.stringify(recovery.records[0].local),
    JSON.stringify(sync.semanticValue({ name: "Local Alice" }, false)),
  );
});

test("uploads a new local change when its dirty timestamp is newer than a changed server baseline", async () => {
  const appId = "newer-local";
  const server = semanticServer();
  const base = sync.semanticValue({ name: "Base" }, false);
  const remote = sync.semanticValue({ name: "Remote" }, false);
  server.records.set(server.key("classes", "class-alice"), {
    collection: "classes",
    recordId: "class-alice",
    revision: 2,
    value: remote,
    updatedAt: "2026-08-12T00:00:00.000Z",
  });
  const local = new Map([["class-alice", { name: "Local" }]]);
  const windowRef = windowFixture(appId, server, {
    version: 1,
    enabled: true,
    records: {
      ["classes\u001fclass-alice"]: {
        revision: 1,
        remoteFingerprint: JSON.stringify(base),
        localDeleted: false,
        dirtyAt: "2026-08-12T00:00:01.000Z",
      },
    },
  });
  const client = sync.createSemanticSync({
    windowRef,
    appId,
    profiles: [profile(local, [])],
  });

  await client.reconcile();

  assert.deepEqual(local.get("class-alice"), { name: "Local" });
  assert.equal(
    JSON.stringify(server.records.get(server.key("classes", "class-alice")).value),
    JSON.stringify(sync.semanticValue({ name: "Local" }, false)),
  );
  assert.equal(windowRef.localStorage.getItem(sync.recoveryKey(appId)), null);
});

test("uses the server winner for an old record with no dirty timestamp and preserves local recovery", async () => {
  const appId = "legacy-conflict";
  const server = semanticServer();
  const base = sync.semanticValue({ name: "Base" }, false);
  const remote = sync.semanticValue({ name: "Remote" }, false);
  server.records.set(server.key("classes", "class-alice"), {
    collection: "classes",
    recordId: "class-alice",
    revision: 2,
    value: remote,
    updatedAt: "2026-08-12T00:00:00.000Z",
  });
  const local = new Map([["class-alice", { name: "Local" }]]);
  const windowRef = windowFixture(appId, server, {
    version: 1,
    enabled: true,
    records: {
      ["classes\u001fclass-alice"]: {
        revision: 1,
        remoteFingerprint: JSON.stringify(base),
        localDeleted: false,
      },
    },
  });
  const client = sync.createSemanticSync({
    windowRef,
    appId,
    profiles: [profile(local, [])],
  });

  await client.reconcile();

  assert.deepEqual(local.get("class-alice"), { name: "Remote" });
  const recovery = JSON.parse(windowRef.localStorage.getItem(sync.recoveryKey(appId)));
  assert.equal(
    JSON.stringify(recovery.records[0].local),
    JSON.stringify(sync.semanticValue({ name: "Local" }, false)),
  );
});

test("keeps the server winner after a concurrent save and retains the displaced local record", async () => {
  const appId = "concurrent-save";
  const server = semanticServer();
  const base = sync.semanticValue({ name: "Base" }, false);
  const remote = sync.semanticValue({ name: "Remote" }, false);
  server.records.set(server.key("classes", "class-alice"), {
    collection: "classes",
    recordId: "class-alice",
    revision: 1,
    value: base,
    updatedAt: "2026-08-12T00:00:00.000Z",
  });
  server.setBeforePut((_request, records) => {
    records.set(server.key("classes", "class-alice"), {
      collection: "classes",
      recordId: "class-alice",
      revision: 2,
      value: remote,
      updatedAt: "2026-08-12T00:00:01.000Z",
    });
  });

  const local = new Map([["class-alice", { name: "Local" }]]);
  const windowRef = windowFixture(appId, server, {
    version: 1,
    enabled: true,
    records: {
      ["classes\u001fclass-alice"]: {
        revision: 1,
        remoteFingerprint: JSON.stringify(base),
        localDeleted: false,
      },
    },
  });
  const client = sync.createSemanticSync({
    windowRef,
    appId,
    profiles: [profile(local, [])],
  });

  await client.reconcile();

  assert.deepEqual(local.get("class-alice"), { name: "Remote" });
  const recovery = JSON.parse(windowRef.localStorage.getItem(sync.recoveryKey(appId)));
  assert.equal(
    JSON.stringify(recovery.records[0].local),
    JSON.stringify(sync.semanticValue({ name: "Local" }, false)),
  );
});
