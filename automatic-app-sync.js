/* Owner-scoped automatic record synchronization. No controls are rendered. */
(function automaticAppSyncModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (!root || !root.document || !api.automaticSyncSite(root)) return;
  const script = root.document.currentScript;
  const appId = script && script.dataset ? script.dataset.appId : "";
  if (appId) api.install(root, appId);
}(typeof window === "undefined" ? globalThis : window, function automaticAppSyncFactory() {
  "use strict";

  const VALUE_SCHEMA_VERSION = 1;
  const METADATA_PREFIX = "__ryan_semantic_private_sync_";
  const MAX_VALUE_BYTES = 900 * 1024;
  const SEPARATOR = "\u001f";
  const RECOVERY_PREFIX = "__ryan_semantic_auto_sync_recovery_";
  const RECOVERY_RECORD_LIMIT = 6;
  const MAX_RECOVERY_BYTES = 2 * 1024 * 1024;

  const isPlainObject = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.prototype.toString.call(value) === "[object Object]";
  };

  const exactKeys = (value, keys) => (
    isPlainObject(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key))
  );

  const byteLength = (value) => new TextEncoder().encode(value).byteLength;

  const safeJson = (value, depth) => {
    const nextDepth = depth || 0;
    if (nextDepth > 48 || value === null) return nextDepth <= 48;
    if (typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) {
      return value.length <= 20000 && value.every((item) => safeJson(item, nextDepth + 1));
    }
    if (!isPlainObject(value)) return false;
    const entries = Object.entries(value);
    return entries.length <= 20000 && entries.every(([key, item]) => (
      key.length <= 240 && key !== "__proto__" && key !== "constructor"
      && key !== "prototype" && safeJson(item, nextDepth + 1)
    ));
  };

  const semanticValue = (value, deleted) => ({
    schemaVersion: VALUE_SCHEMA_VERSION,
    deleted: Boolean(deleted),
    value: deleted ? null : value,
  });

  const validSemanticValue = (value) => {
    if (!exactKeys(value, ["schemaVersion", "deleted", "value"])
      || value.schemaVersion !== VALUE_SCHEMA_VERSION
      || typeof value.deleted !== "boolean") return false;
    if (value.deleted) return value.value === null;
    if (!safeJson(value.value)) return false;
    try {
      return byteLength(JSON.stringify(value.value)) <= MAX_VALUE_BYTES;
    } catch (_error) {
      return false;
    }
  };

  const fingerprint = (value) => {
    if (!validSemanticValue(value)) throw new Error("A semantic sync record is invalid.");
    return JSON.stringify(value);
  };

  const recordKey = (collection, recordId) => collection + SEPARATOR + recordId;

  const splitRecordKey = (key) => {
    const index = key.indexOf(SEPARATOR);
    return index > 0 ? [key.slice(0, index), key.slice(index + SEPARATOR.length)] : null;
  };

  const metadataKey = (appId) => METADATA_PREFIX + appId + "_v1";
  const recoveryKey = (appId) => RECOVERY_PREFIX + appId + "_v1";

  const emptyMetadata = () => ({ version: 1, enabled: true, records: Object.create(null) });

  const validTimestamp = (value) => {
    if (typeof value !== "string") return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  };

  const normalizedMetadataRecord = (value) => {
    if (!isPlainObject(value)
      || !(value.revision === null || (Number.isSafeInteger(value.revision) && value.revision > 0))
      || !(value.remoteFingerprint === null || typeof value.remoteFingerprint === "string")
      || typeof value.localDeleted !== "boolean") return null;
    return {
      revision: value.revision,
      remoteFingerprint: value.remoteFingerprint,
      localDeleted: value.localDeleted,
      dirtyAt: validTimestamp(value.dirtyAt) ? value.dirtyAt : null,
    };
  };

  const readMetadata = (windowRef, appId) => {
    try {
      const parsed = JSON.parse(windowRef.localStorage.getItem(metadataKey(appId)) || "null");
      if (!isPlainObject(parsed) || parsed.version !== 1 || typeof parsed.enabled !== "boolean"
        || !isPlainObject(parsed.records)) return emptyMetadata();
      const records = Object.create(null);
      Object.entries(parsed.records).forEach(([key, value]) => {
        if (key.length > 520 || key.includes("__proto__") || key.includes("constructor")) return;
        const normalized = normalizedMetadataRecord(value);
        if (normalized) records[key] = normalized;
      });
      return { version: 1, enabled: parsed.enabled, records };
    } catch (_error) {
      return emptyMetadata();
    }
  };

  const saveMetadata = (windowRef, appId, value) => {
    windowRef.localStorage.setItem(metadataKey(appId), JSON.stringify(value));
  };

  const automaticSyncSite = (windowRef) => {
    const location = windowRef.location;
    return Boolean(location) && location.protocol === "https:"
      && typeof location.hostname === "string" && location.hostname.endsWith(".chatgpt.site");
  };

  const statusEvent = (windowRef, detail) => {
    if (typeof windowRef.CustomEvent !== "function" || typeof windowRef.dispatchEvent !== "function") return;
    windowRef.dispatchEvent(new windowRef.CustomEvent("ryan-automatic-app-sync-status", { detail }));
  };

  const responseJson = async (response) => {
    try {
      return await response.json();
    } catch (_error) {
      return null;
    }
  };

  const validRecordId = (value) => (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/.test(value)
  );

  const normalizeRemoteRecord = (value) => {
    if (!exactKeys(value, ["recordId", "revision", "updatedAt", "value"])
      || !validRecordId(value.recordId)
      || !Number.isSafeInteger(value.revision) || value.revision <= 0
      || typeof value.updatedAt !== "string"
      || !validSemanticValue(value.value)) return null;
    return value;
  };


  function createSemanticSync(options) {
    const windowRef = options.windowRef;
    const appId = options.appId;
    const profiles = options.profiles;
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    let metadata = readMetadata(windowRef, appId);
    let syncing = false;
    let queued = false;
    let timer = null;

    const persist = () => saveMetadata(windowRef, appId, metadata);

    const emit = (state, message) => {
      const detail = { state, message, conflicts: [] };
      statusEvent(windowRef, detail);
      if (typeof options.onStatus === "function") options.onStatus(detail);
    };

    const stateFor = (profile, id) => {
      const key = recordKey(profile.collection, id);
      const existing = metadata.records[key];
      return existing || {
        revision: null,
        remoteFingerprint: null,
        localDeleted: false,
        dirtyAt: null,
      };
    };

    const writeState = (profile, id, value) => {
      metadata.records[recordKey(profile.collection, id)] = value;
      persist();
    };

    const forgetState = (profile, id) => {
      delete metadata.records[recordKey(profile.collection, id)];
      persist();
    };

    const recoveryEntries = () => {
      try {
        const parsed = JSON.parse(windowRef.localStorage.getItem(recoveryKey(appId)) || "null");
        if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records)) return [];
        return parsed.records.filter((entry) => (
          isPlainObject(entry)
          && typeof entry.collection === "string"
          && typeof entry.recordId === "string"
          && typeof entry.savedAt === "string"
          && typeof entry.reason === "string"
          && validSemanticValue(entry.local)
        ));
      } catch (_error) {
        return [];
      }
    };

    const preserveLocalBeforeOverwrite = (profile, recordId, local, remote, reason) => {
      if (!local || !remote || fingerprint(local) === fingerprint(remote.value)) return;
      const entry = {
        collection: profile.collection,
        recordId,
        savedAt: new Date().toISOString(),
        reason,
        local,
      };
      const records = recoveryEntries()
        .filter((item) => item.collection !== profile.collection || item.recordId !== recordId)
        .concat(entry)
        .slice(-RECOVERY_RECORD_LIMIT);
      let snapshot = { version: 1, records };
      let raw = JSON.stringify(snapshot);
      while (byteLength(raw) > MAX_RECOVERY_BYTES && snapshot.records.length > 1) {
        snapshot = { version: 1, records: snapshot.records.slice(1) };
        raw = JSON.stringify(snapshot);
      }
      if (byteLength(raw) > MAX_RECOVERY_BYTES) {
        throw new Error("Automatic sync kept the local record because its recovery snapshot is too large.");
      }
      windowRef.localStorage.setItem(recoveryKey(appId), raw);
      if (windowRef.localStorage.getItem(recoveryKey(appId)) !== raw) {
        throw new Error("Automatic sync kept the local record because its recovery snapshot could not be verified.");
      }
    };

    const fetchCollection = async (collection) => {
      const url = "/api/app-sync?appId=" + encodeURIComponent(appId)
        + "&collection=" + encodeURIComponent(collection);
      const response = await windowRef.fetch(url, { cache: "no-store", credentials: "same-origin" });
      const body = await responseJson(response);
      if (!response.ok || !exactKeys(body, ["appId", "collection", "records", "version"])
        || body.version !== 1 || body.appId !== appId || body.collection !== collection
        || !Array.isArray(body.records)) {
        throw new Error((body && body.error) || "Automatic app sync is unavailable.");
      }
      const records = new Map();
      for (const item of body.records) {
        const record = normalizeRemoteRecord(item);
        if (!record || records.has(record.recordId)) {
          throw new Error("A synchronized record needs review.");
        }
        records.set(record.recordId, record);
      }
      return records;
    };

    const put = async (profile, recordId, value, expectedRevision) => {
      const response = await windowRef.fetch("/api/app-sync", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          appId,
          collection: profile.collection,
          recordId,
          expectedRevision,
          value,
        }),
      });
      const body = await responseJson(response);
      if (response.ok && isPlainObject(body)) {
        const record = normalizeRemoteRecord(body.record);
        if (record) return { ok: true, record };
      }
      if (response.status === 409 && isPlainObject(body)) {
        const current = normalizeRemoteRecord(body.current);
        if (current) return { ok: false, current };
      }
      throw new Error((body && body.error) || "Automatic app sync could not save a record.");
    };

    const listLocal = async (profile) => {
      const entries = await profile.readAll();
      if (!entries || typeof entries.has !== "function" || typeof entries.get !== "function"
        || typeof entries.forEach !== "function" || typeof entries.keys !== "function") {
        throw new Error("This app returned an invalid synchronized record list.");
      }
      entries.forEach((value, id) => {
        if (!profile.owns(id) || !profile.validate(value, id)) {
          throw new Error("This app has invalid local data. No remote write was made.");
        }
      });
      return entries;
    };

    const localValueFor = (profile, id, local, state) => {
      if (local.has(id)) return semanticValue(local.get(id), false);
      if (state.localDeleted) return semanticValue(null, true);
      return null;
    };

    const acknowledge = (profile, id, remote) => {
      writeState(profile, id, {
        revision: remote.revision,
        remoteFingerprint: fingerprint(remote.value),
        localDeleted: remote.value.deleted,
        dirtyAt: null,
      });
    };

    const applyRemote = async (profile, id, remote) => {
      await profile.applyRemote(id, remote.value);
      acknowledge(profile, id, remote);
    };

    const adoptServerRecord = async (profile, id, local, remote, reason) => {
      if (!remote) return false;
      preserveLocalBeforeOverwrite(profile, id, local, remote, reason);
      await applyRemote(profile, id, remote);
      return true;
    };

    const syncOne = async (profile, id, local, remote) => {
      const state = stateFor(profile, id);
      const localValue = localValueFor(profile, id, local, state);
      const localFingerprint = localValue ? fingerprint(localValue) : null;

      if (!remote) {
        if (!localValue) {
          if (state.revision !== null) forgetState(profile, id);
          return false;
        }
        if (localValue.deleted) {
          writeState(profile, id, {
            revision: null,
            remoteFingerprint: null,
            localDeleted: true,
          });
          return false;
        }
        const uploaded = await put(profile, id, localValue, null);
        if (uploaded.ok) {
          acknowledge(profile, id, uploaded.record);
          return true;
        }
        return adoptServerRecord(
          profile,
          id,
          localValue,
          uploaded.current,
          "another device created this record first",
        );
      }

      const remoteFingerprint = fingerprint(remote.value);
      if (state.revision === null) {
        if (!localValue) {
          await applyRemote(profile, id, remote);
          return true;
        }
        if (localFingerprint === remoteFingerprint) {
          acknowledge(profile, id, remote);
          return false;
        }
        return adoptServerRecord(
          profile,
          id,
          localValue,
          remote,
          "the server already had the authoritative record",
        );
      }

      const localChanged = localFingerprint !== state.remoteFingerprint;
      const remoteChanged = remote.revision !== state.revision
        || remoteFingerprint !== state.remoteFingerprint;

      if (!localValue) {
        if (!localChanged && !remoteChanged) {
          acknowledge(profile, id, remote);
          return false;
        }
        return adoptServerRecord(
          profile,
          id,
          null,
          remote,
          "the local record was missing while the server changed",
        );
      }

      if (localFingerprint === remoteFingerprint) {
        acknowledge(profile, id, remote);
        return false;
      }
      if (localChanged && remoteChanged) {
        if (state.dirtyAt && Date.parse(state.dirtyAt) > Date.parse(remote.updatedAt)) {
          const uploaded = await put(profile, id, localValue, remote.revision);
          if (uploaded.ok) {
            acknowledge(profile, id, uploaded.record);
            return true;
          }
          return adoptServerRecord(
            profile,
            id,
            localValue,
            uploaded.current,
            "another device saved this record first",
          );
        }
        return adoptServerRecord(
          profile,
          id,
          localValue,
          remote,
          "the same record changed on another device",
        );
      }
      if (localChanged) {
        const uploaded = await put(profile, id, localValue, remote.revision);
        if (uploaded.ok) {
          acknowledge(profile, id, uploaded.record);
          return true;
        }
        return adoptServerRecord(
          profile,
          id,
          localValue,
          uploaded.current,
          "another device saved this record first",
        );
      }
      if (remoteChanged) {
        await applyRemote(profile, id, remote);
        return true;
      }
      acknowledge(profile, id, remote);
      return false;
    };

    const remoteCollections = () => Array.from(new Set(profiles.map((profile) => profile.collection)));

    const reconcile = async () => {
      if (syncing) return;
      syncing = true;
      queued = false;
      try {
        const remoteByCollection = new Map();
        for (const collection of remoteCollections()) {
          remoteByCollection.set(collection, await fetchCollection(collection));
        }
        let changed = 0;
        for (const profile of profiles) {
          const local = await listLocal(profile);
          const remote = remoteByCollection.get(profile.collection);
          const ids = new Set(local.keys());
          remote.forEach((_value, id) => {
            if (profile.owns(id)) ids.add(id);
          });
          Object.keys(metadata.records).forEach((key) => {
            const parts = splitRecordKey(key);
            if (parts && parts[0] === profile.collection && profile.owns(parts[1])) ids.add(parts[1]);
          });
          for (const id of ids) {
            if (await syncOne(profile, id, local, remote.get(id) || null)) changed += 1;
          }
        }
        emit("synced", changed ? "Automatic records reconciled." : "Automatic records are current.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Automatic app sync is unavailable.";
        const offline = /offline|network|fetch|unavailable|sign in/i.test(message);
        emit(offline ? "offline" : "error", offline
          ? "Local edits are preserved and automatic sync will retry."
          : message);
      } finally {
        syncing = false;
        if (queued) schedule();
      }
    };

    const schedule = () => {
      if (queued) return;
      queued = true;
      windowRef.setTimeout(() => { void reconcile(); }, 0);
    };

    const noteLocal = (profile, recordId, deleted) => {
      if (!profile || !profile.owns(recordId)) return;
      const state = stateFor(profile, recordId);
      writeState(profile, recordId, {
        revision: state.revision,
        remoteFingerprint: state.remoteFingerprint,
        localDeleted: Boolean(deleted),
        dirtyAt: new Date().toISOString(),
      });
      schedule();
    };

    const localSave = async (profileId, recordId, value, deleted) => {
      const profile = profileById.get(profileId);
      if (!profile || !profile.owns(recordId)) throw new Error("This app requested an unsupported synchronized record.");
      if (!deleted && !profile.validate(value, recordId)) throw new Error("This app rejected the local synchronized record.");
      await profile.writeLocal(recordId, value, Boolean(deleted));
      noteLocal(profile, recordId, Boolean(deleted));
      return true;
    };

    const start = () => {
      if (!metadata.enabled) {
        metadata.enabled = true;
        persist();
      }
      schedule();
      if (timer === null) timer = windowRef.setInterval(() => { void reconcile(); }, 20000);
      windowRef.addEventListener("online", schedule);
      windowRef.addEventListener("focus", schedule);
      const documentRef = windowRef.document;
      if (documentRef && typeof documentRef.addEventListener === "function") {
        documentRef.addEventListener("visibilitychange", () => {
          if (documentRef.visibilityState !== "hidden") schedule();
        });
      }
    };

    return {
      start,
      reconcile,
      localSave,
      noteLocal,
      get enabled() { return true; },
      get timer() { return timer; },
    };
  }

  const fixedProfile = (id, adapter, alreadyLocal) => ({
    id,
    collection: adapter.collection,
    owns: (recordId) => recordId === adapter.recordId,
    validate: adapter.validate,
    readAll: async () => {
      const value = await adapter.readLocal();
      return value === undefined || value === null
        ? new Map()
        : new Map([[adapter.recordId, value]]);
    },
    writeLocal: async (_recordId, value, deleted) => {
      if (deleted || !adapter.validate(value)) throw new Error("A fixed semantic record cannot be deleted.");
      if (!alreadyLocal) await adapter.writeLocal(value, { source: "local", deleted: false });
    },
    applyRemote: async (_recordId, payload) => {
      if (payload.deleted || !adapter.validate(payload.value)) {
        throw new Error("A synchronized fixed semantic record was rejected.");
      }
      await adapter.applyRemote(payload.value, { source: "remote", deleted: false });
    },
  });

  const listProfile = (id, adapter, alreadyLocal) => ({
    id,
    collection: adapter.collection,
    owns: (recordId) => validRecordId(recordId),
    validate: adapter.validate,
    readAll: async () => {
      const records = await adapter.listLocal();
      if (!Array.isArray(records)) throw new Error("This app returned an invalid semantic record list.");
      const result = new Map();
      records.forEach((record) => {
        if (!isPlainObject(record) || !validRecordId(record.recordId) || result.has(record.recordId)) {
          throw new Error("This app returned duplicate or invalid semantic records.");
        }
        result.set(record.recordId, record.value);
      });
      return result;
    },
    writeLocal: async (recordId, value, deleted) => {
      if (!alreadyLocal) {
        await adapter.writeLocal(
          recordId,
          deleted ? null : value,
          { source: "local", deleted: Boolean(deleted) },
        );
      }
    },
    applyRemote: async (recordId, payload) => {
      if (!payload.deleted && !adapter.validate(payload.value, recordId)) {
        throw new Error("A synchronized semantic record was rejected.");
      }
      await adapter.applyRemote(
        recordId,
        payload.deleted ? null : payload.value,
        { source: "remote", deleted: payload.deleted },
      );
    },
  });

  function installAdapterApp(windowRef, appId, store, profileDefinitions, handles) {
    if (!store || typeof store.makeAdapters !== "function" || typeof store.attachHandles !== "function") {
      throw new Error("This app's semantic storage adapters are unavailable.");
    }
    const adapters = store.makeAdapters();
    const profiles = profileDefinitions(adapters);
    const client = createSemanticSync({ windowRef, appId, profiles });
    store.attachHandles(handles(client));
    return client;
  }

  function installCandyland(windowRef) {
    const store = windowRef.CandylandStorage;
    return installAdapterApp(
      windowRef,
      "candyland-circle-quest",
      store,
      (adapters) => [
        fixedProfile("preferences", adapters.preferences, true),
        listProfile("classes", adapters.classes, true),
        listProfile("turns", adapters.turns, true),
        fixedProfile("sound", adapters.sound, true),
      ],
      (client) => ({
        preferences: { save: (value) => client.localSave("preferences", "current", value, false) },
        classes: {
          save: (recordId, value) => client.localSave("classes", recordId, value, false),
          remove: (recordId) => client.localSave("classes", recordId, null, true),
        },
        turns: {
          save: (recordId, value) => client.localSave("turns", recordId, value, false),
          remove: (recordId) => client.localSave("turns", recordId, null, true),
        },
        sound: { save: (value) => client.localSave("sound", "sound", value, false) },
      }),
    );
  }

  function installColorGame(windowRef) {
    const store = windowRef.ColorGameStorage;
    return installAdapterApp(
      windowRef,
      "color-game",
      store,
      (adapters) => [
        fixedProfile("configuration", adapters.configuration, false),
        listProfile("savedLists", adapters.savedLists, false),
        fixedProfile("scoreboard", adapters.scoreboard, false),
        fixedProfile("sound", adapters.sound, false),
      ],
      (client) => ({
        configuration: { save: (value) => client.localSave("configuration", "current", value, false) },
        savedLists: {
          save: (recordId, value) => client.localSave("savedLists", recordId, value, false),
          remove: (recordId) => client.localSave("savedLists", recordId, null, true),
        },
        scoreboard: { save: (value) => client.localSave("scoreboard", "current", value, false) },
        sound: { save: (value) => client.localSave("sound", "sound", value, false) },
      }),
    );
  }

  function installScavenger(windowRef) {
    const store = windowRef.ScavengerStore;
    if (!store) throw new Error("Scavenger Hunt semantic storage is unavailable.");
    const profiles = [
      {
        id: "preferences",
        collection: "preferences",
        owns: (recordId) => recordId === "current",
        validate: store.isPreferencesValue,
        readAll: async () => {
          const state = store.readState();
          return state ? new Map([["current", store.preferencesValue(state)]]) : new Map();
        },
        writeLocal: async () => {},
        applyRemote: async (_recordId, payload) => {
          await store.applyPreferences(payload.deleted ? null : payload.value, {
            source: "remote",
            deleted: payload.deleted,
          });
        },
      },
      {
        id: "classes",
        collection: "classes",
        owns: validRecordId,
        validate: store.isClassValue,
        readAll: async () => {
          const records = await store.listClassRecords();
          return new Map(records.map((item) => [item.recordId, item.value]));
        },
        writeLocal: async () => {},
        applyRemote: async (recordId, payload) => {
          await store.applyClassRecord(recordId, payload.deleted ? null : payload.value, {
            source: "remote",
            deleted: payload.deleted,
          });
        },
      },
      {
        id: "lessons",
        collection: "lesson-templates",
        owns: validRecordId,
        validate: store.isLessonValue,
        readAll: async () => {
          const records = await store.listLessonRecords();
          return new Map(records.map((item) => [item.recordId, item.value]));
        },
        writeLocal: async () => {},
        applyRemote: async (recordId, payload) => {
          await store.applyLessonRecord(recordId, payload.deleted ? null : payload.value, {
            source: "remote",
            deleted: payload.deleted,
          });
        },
      },
    ];
    const client = createSemanticSync({ windowRef, appId: "scavenger-hunt", profiles });
    windowRef.addEventListener(store.changeEvent, (event) => {
      const detail = event && event.detail;
      if (!detail || detail.source === "remote"
        || typeof detail.oldRaw !== "string" && detail.oldRaw !== null
        || typeof detail.newRaw !== "string" && detail.newRaw !== null) return;
      void store.diffRecords(detail.oldRaw, detail.newRaw).then((changes) => {
        if (changes.preferencesChanged) client.noteLocal(profiles[0], "current", false);
        changes.classes.forEach((change) => client.noteLocal(profiles[1], change.recordId, change.deleted));
        changes.lessons.forEach((change) => client.noteLocal(profiles[2], change.recordId, change.deleted));
      }).catch(() => {
        statusEvent(windowRef, {
          state: "error",
          message: "Scavenger Hunt local data needs review before automatic app sync.",
          conflicts: [],
        });
      });
    });
    return client;
  }

  const install = (windowRef, appId) => {
    let client;
    try {
      if (appId === "candyland-circle-quest") client = installCandyland(windowRef);
      else if (appId === "color-game") client = installColorGame(windowRef);
      else if (appId === "scavenger-hunt") client = installScavenger(windowRef);
      else return null;
    } catch (error) {
      statusEvent(windowRef, {
        state: "error",
        message: error instanceof Error ? error.message : "Automatic app sync could not start.",
        conflicts: [],
      });
      return null;
    }
    client.start();
    return client;
  };

  return {
    VALUE_SCHEMA_VERSION,
    semanticValue,
    validSemanticValue,
    automaticSyncSite,
    recoveryKey,
    createSemanticSync,
    install,
  };
}));
