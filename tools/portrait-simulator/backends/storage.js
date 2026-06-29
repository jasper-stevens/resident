const DB_NAME = "resident-field-recorder";
const DB_VERSION = 2;
const STORE = "clips";
const META = "meta";

export const MAX_CLIPS = 10;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("uploaded", "uploaded", { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "key" });
      }
    };
  });
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

export function createStorage() {
  let ready = openDb();

  async function db() {
    return ready;
  }

  async function all() {
    const database = await db();
    return new Promise((resolve, reject) => {
      const req = tx(database, STORE, "readonly").getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  async function getMeta(key) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const req = tx(database, META, "readonly").get(key);
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async function setMeta(key, value) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const req = tx(database, META, "readwrite").put({ key, value });
      req.onsuccess = () => resolve(value);
      req.onerror = () => reject(req.error);
    });
  }

  async function migrateLegacyClips() {
    const clips = await all();
    const legacy = clips.filter((c) => c.groupId == null);
    if (legacy.length === 0) return;
    legacy.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    for (let i = 0; i < legacy.length; i++) {
      legacy[i].groupId = 1;
      legacy[i].captureIndex = i + 1;
      await setClip(legacy[i]);
    }
  }

  async function setClip(clip) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const req = tx(database, STORE, "readwrite").put(clip);
      req.onsuccess = () => resolve(clip);
      req.onerror = () => reject(req.error);
    });
  }

  async function ensureGroupState(cloudMaxGroupId = 0) {
    const clips = await all();
    const localMax = clips.reduce((m, c) => Math.max(m, c.groupId ?? 0), 0);
    const maxKnown = Math.max(localMax, cloudMaxGroupId);
    let currentGroupId = await getMeta("currentGroupId");

    if (currentGroupId != null) {
      const hasPending = clips.some((c) => !c.uploaded && c.groupId === currentGroupId);
      if (!hasPending && maxKnown >= currentGroupId) {
        currentGroupId = maxKnown + 1;
        await setMeta("currentGroupId", currentGroupId);
      }
      return currentGroupId;
    }

    const hasPending = clips.some((c) => !c.uploaded);
    if (clips.length === 0 && cloudMaxGroupId > 0) {
      currentGroupId = cloudMaxGroupId + 1;
    } else {
      currentGroupId = maxKnown > 0 ? (hasPending ? maxKnown : maxKnown + 1) : 1;
    }
    await setMeta("currentGroupId", currentGroupId);
    return currentGroupId;
  }

  return {
    async init() {
      await ready;
      await migrateLegacyClips();
      await ensureGroupState(0);
    },

    async save(clip) {
      return setClip(clip);
    },

    async get(id) {
      const database = await db();
      return new Promise((resolve, reject) => {
        const req = tx(database, STORE, "readonly").get(id);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    },

    async list() {
      const clips = await all();
      clips.sort((a, b) => {
        if (a.groupId !== b.groupId) return a.groupId - b.groupId;
        return a.captureIndex - b.captureIndex;
      });
      return clips;
    },

    async nextCaptureSlot(cloudMaxGroupId = 0) {
      const groupId = await ensureGroupState(cloudMaxGroupId);
      const clips = await all();
      const inGroup = clips.filter((c) => c.groupId === groupId);
      return { groupId, captureIndex: inGroup.length + 1 };
    },

    async advanceGroup(cloudMaxGroupId = 0) {
      const current = await ensureGroupState(cloudMaxGroupId);
      await setMeta("currentGroupId", current + 1);
    },

    async syncGroupState(cloudMaxGroupId = 0) {
      return ensureGroupState(cloudMaxGroupId);
    },

    async markUploaded(id) {
      const clip = await this.get(id);
      if (!clip) return;
      clip.uploaded = true;
      await this.save(clip);
    },

    async deleteUploaded() {
      const clips = await all();
      const database = await db();
      const toDelete = clips.filter((c) => c.uploaded);
      await Promise.all(
        toDelete.map(
          (c) =>
            new Promise((resolve, reject) => {
              const req = tx(database, STORE, "readwrite").delete(c.id);
              req.onsuccess = () => resolve();
              req.onerror = () => reject(req.error);
            }),
        ),
      );
      return toDelete.length;
    },

    async clipsOnDevice() {
      return (await all()).length;
    },

    async clipsRemaining() {
      const count = await this.clipsOnDevice();
      return Math.max(0, MAX_CLIPS - count);
    },

    async clipsUploaded() {
      return (await all()).filter((c) => c.uploaded).length;
    },
  };
}
