const DB_NAME = "resident-field-recorder";
const DB_VERSION = 1;
const STORE = "clips";

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
    };
  });
}

function tx(store, mode) {
  return store.transaction(STORE, mode).objectStore(STORE);
}

export function createStorage() {
  let ready = openDb();

  async function all() {
    const db = await ready;
    return new Promise((resolve, reject) => {
      const req = tx(db, "readonly").getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  return {
    async init() {
      await ready;
    },

    async save(clip) {
      const db = await ready;
      return new Promise((resolve, reject) => {
        const req = tx(db, "readwrite").put(clip);
        req.onsuccess = () => resolve(clip);
        req.onerror = () => reject(req.error);
      });
    },

    async get(id) {
      const db = await ready;
      return new Promise((resolve, reject) => {
        const req = tx(db, "readonly").get(id);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    },

    async list() {
      const clips = await all();
      clips.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return clips;
    },

    async markUploaded(id) {
      const clip = await this.get(id);
      if (!clip) return;
      clip.uploaded = true;
      await this.save(clip);
    },

    async deleteUploaded() {
      const clips = await all();
      const db = await ready;
      const toDelete = clips.filter((c) => c.uploaded);
      await Promise.all(
        toDelete.map(
          (c) =>
            new Promise((resolve, reject) => {
              const req = tx(db, "readwrite").delete(c.id);
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
