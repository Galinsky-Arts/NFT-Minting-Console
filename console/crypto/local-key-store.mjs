/** Browser-local key persistence. This is not device authorization or recovery.
 * Keep private save UI disabled until those flows are accepted. */
import { createReleaseWrappingKey } from './workspace.mjs';

const DB_NAME = 'nft-console-private-keys-v1';
const STORE = 'wrapping-keys';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const fail = () => { throw new Error('Local draft key unavailable.'); };
function accountKey(wallet, chainId) {
  if (typeof wallet !== 'string' || !ADDRESS.test(wallet.toLowerCase()) ||
      ![1, 11155111, 31337].includes(chainId)) fail();
  return `${chainId}:${wallet.toLowerCase()}`;
}
function validKey(key) {
  return key instanceof globalThis.CryptoKey && key.type === 'secret' && !key.extractable &&
    key.algorithm.name === 'AES-GCM' && key.algorithm.length === 256 &&
    key.usages.includes('encrypt') && key.usages.includes('decrypt');
}
function openDatabase() {
  if (!globalThis.indexedDB || !globalThis.isSecureContext) fail();
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Local draft key unavailable.'));
    request.onblocked = () => reject(new Error('Local draft key store is blocked.'));
  });
}
function operate(db, mode, action) {
  return new Promise((resolve, reject) => {
    let settled = false, result;
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => { settled = true; resolve(result); };
    tx.onabort = tx.onerror = () => {
      if (!settled) { settled = true; reject(new Error('Local draft key unavailable.')); }
    };
  });
}
async function withDatabase(operation) {
  const db = await openDatabase();
  try { return await operation(db); } finally { db.close(); }
}
/** Never creates a replacement key for an existing ciphertext record. */
export async function loadLocalReleaseKey(wallet, chainId) {
  const id = accountKey(wallet, chainId);
  return withDatabase(async db => {
    const key = await operate(db, 'readonly', store => store.get(id));
    if (key === undefined) return null;
    if (!validKey(key)) fail();
    return key;
  });
}
/** Explicit first-use creation only. An existing key is returned unchanged.
 * Callers must warn that clearing browser storage loses access without recovery. */
export async function createLocalReleaseKey(wallet, chainId) {
  const id = accountKey(wallet, chainId);
  const existing = await loadLocalReleaseKey(wallet, chainId);
  if (existing) return existing;
  const candidate = await createReleaseWrappingKey();
  return withDatabase(async db => {
    try { await operate(db, 'readwrite', store => store.add(candidate, id)); return candidate; }
    catch {
      const raced = await loadLocalReleaseKey(wallet, chainId);
      if (raced) return raced;
      fail();
    }
  });
}
