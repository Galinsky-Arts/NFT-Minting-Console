/** Client boundary for opaque release records. The request function should be
 * the authenticated same-origin API client; it never receives plaintext. */
import { openReleaseDraft, sealReleaseDraft } from './workspace.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_REVISION = (1n << 63n) - 1n;
const fail = () => { throw new Error('Encrypted release response failed validation.'); };
function transport(request, id, wrappingKey) {
  if (typeof request !== 'function' || typeof id !== 'string' || !UUID.test(id) ||
      !(wrappingKey instanceof globalThis.CryptoKey)) fail();
}
function record(value, id) {
  if (!value || typeof value !== 'object' || value.id !== id ||
      typeof value.ciphertext !== 'string' || typeof value.nonce !== 'string' ||
      typeof value.revision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value.revision) ||
      BigInt(value.revision) > MAX_REVISION) fail();
  return value;
}
function revision(value, maximum = MAX_REVISION - 1n) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > maximum) fail();
  return value;
}
export async function createEncryptedRelease(draft, { id, wrappingKey, request } = {}) {
  transport(request, id, wrappingKey);
  const sealed = await sealReleaseDraft(draft, { id, wrappingKey });
  const returned = record(await request('/api/releases', { method: 'POST', body: sealed }), id);
  if (returned.ciphertext !== sealed.ciphertext || returned.nonce !== sealed.nonce) fail();
  return Object.freeze({ id, revision: returned.revision, created: returned.created === true });
}
/** minimumRevision must come from trusted client state, never this response.
 * This detects a lower reported revision; server metadata is not authenticated
 * and cannot prove freshness against a malicious server relabeling old bytes. */
export async function readEncryptedRelease(id, { wrappingKey, request, minimumRevision } = {}) {
  transport(request, id, wrappingKey);
  if (minimumRevision !== undefined) revision(minimumRevision, MAX_REVISION);
  const returned = record(await request(`/api/releases/${id}`), id);
  if (minimumRevision !== undefined && BigInt(returned.revision) < BigInt(minimumRevision)) fail();
  const draft = await openReleaseDraft(returned, { expectedId: id, wrappingKey });
  return Object.freeze({ id, revision: returned.revision, draft });
}

/** The server uses expectedRevision for compare-and-swap; each edit reseals
 * with a fresh content key and nonces, even when the plaintext is identical. */
export async function updateEncryptedRelease(draft, { id, expectedRevision, wrappingKey, request } = {}) {
  transport(request, id, wrappingKey); revision(expectedRevision);
  const sealed = await sealReleaseDraft(draft, { id, wrappingKey });
  const returned = record(await request(`/api/releases/${id}`, { method: 'PUT',
    body: { ciphertext: sealed.ciphertext, nonce: sealed.nonce, expectedRevision } }), id);
  if (returned.ciphertext !== sealed.ciphertext || returned.nonce !== sealed.nonce ||
      BigInt(returned.revision) !== BigInt(expectedRevision) + 1n || returned.changed !== true) fail();
  return Object.freeze({ id, revision: returned.revision });
}
