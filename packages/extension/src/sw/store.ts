import { summarize, type Recording, type RecordingSummary } from '@str/shared';

/**
 * Recording store in IndexedDB:
 * - summaries:  small records for listing
 * - recordings: the full recording (network bodies are capped, so this stays small)
 * - images:     checkpoint screenshots as base64 PNG, keyed by blob id
 */

const DB_NAME = 'str';
const DB_VERSION = 1;

interface ImageRecord {
  id: string;
  recordingId: string;
  data: string;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const d = open.result;
      d.createObjectStore('summaries', { keyPath: 'id' });
      d.createObjectStore('recordings', { keyPath: 'id' });
      d.createObjectStore('images', { keyPath: 'id' }).createIndex('byRecording', 'recordingId');
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return dbPromise;
}

/** For tests: forget the cached connection. */
export function resetStoreConnection(): void {
  dbPromise = null;
}

export async function saveRecording(recording: Recording, images: Record<string, string>): Promise<void> {
  const d = await db();
  const tx = d.transaction(['summaries', 'recordings', 'images'], 'readwrite');
  tx.objectStore('summaries').put(summarize(recording));
  tx.objectStore('recordings').put(recording);
  for (const [id, data] of Object.entries(images)) tx.objectStore('images').put({ id, recordingId: recording.id, data } satisfies ImageRecord);
  await done(tx);
}

export async function listRecordings(): Promise<RecordingSummary[]> {
  const d = await db();
  const all = await req(d.transaction('summaries').objectStore('summaries').getAll() as IDBRequest<RecordingSummary[]>);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getRecording(id: string): Promise<Recording | undefined> {
  const d = await db();
  return req(d.transaction('recordings').objectStore('recordings').get(id) as IDBRequest<Recording | undefined>);
}

export async function getImages(ids: string[]): Promise<Record<string, string>> {
  const d = await db();
  const store = d.transaction('images').objectStore('images');
  const out: Record<string, string> = {};
  for (const id of ids) {
    const rec = await req(store.get(id) as IDBRequest<ImageRecord | undefined>);
    if (rec) out[id] = rec.data;
  }
  return out;
}

/** Ids of every checkpoint screenshot in a recording. */
export function imageIds(r: Recording): string[] {
  return r.checkpoints.flatMap((c) => [c.screenshots.region, c.screenshots.viewport]);
}

export async function renameRecording(id: string, title: string): Promise<boolean> {
  const d = await db();
  const tx = d.transaction(['summaries', 'recordings'], 'readwrite');
  const rec = await req(tx.objectStore('recordings').get(id) as IDBRequest<Recording | undefined>);
  if (!rec) return false;
  rec.title = title;
  tx.objectStore('recordings').put(rec);
  tx.objectStore('summaries').put(summarize(rec));
  await done(tx);
  return true;
}

export async function deleteRecording(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['summaries', 'recordings', 'images'], 'readwrite');
  tx.objectStore('summaries').delete(id);
  tx.objectStore('recordings').delete(id);
  const keys = await req(tx.objectStore('images').index('byRecording').getAllKeys(id));
  for (const k of keys) tx.objectStore('images').delete(k);
  await done(tx);
}
