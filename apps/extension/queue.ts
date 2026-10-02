import type { CaptureBatch } from '../../packages/shared/model.ts';
const LIMIT = 8 * 1024 * 1024;
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('salesmartly-archive-queue', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('batches', { keyPath: 'batchId' });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
export async function queued(): Promise<CaptureBatch[]> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('batches', 'readonly'), request = transaction.objectStore('batches').getAll();
    transaction.oncomplete = () => resolve(request.result); transaction.onerror = () => reject(transaction.error);
  });
}
export async function enqueue(batch: CaptureBatch): Promise<void> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('batches', 'readwrite'), store = transaction.objectStore('batches');
    const request = store.getAll(); let error: Error | undefined;
    request.onsuccess = () => {
      const bytes = new TextEncoder().encode(JSON.stringify([...request.result, batch])).length;
      if (bytes > LIMIT) { error = new Error('待写入队列达到 8 MB，已暂停采集。请连接本地程序后重试。'); transaction.abort(); }
      else store.put(batch);
    };
    transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(error ?? transaction.error ?? new Error('Queue transaction failed'));
  });
}
export async function acknowledge(batchId: string): Promise<void> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('batches', 'readwrite'); transaction.objectStore('batches').delete(batchId);
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
  });
}
