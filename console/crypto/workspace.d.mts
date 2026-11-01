export interface OpaqueReleaseEnvelope {
  id: string;
  ciphertext: string;
  nonce: string;
}
/** Generate a non-extractable key for a single authorized client session.
 * Persistence and authorized device transfer are NFT-11 responsibilities. */
export function createReleaseWrappingKey(): Promise<CryptoKey>;
export function sealReleaseDraft(draft: Record<string, unknown>, options: {
  id: string;
  wrappingKey: CryptoKey;
}): Promise<Readonly<OpaqueReleaseEnvelope>>;
export function openReleaseDraft(record: OpaqueReleaseEnvelope, options: {
  expectedId: string;
  wrappingKey: CryptoKey;
}): Promise<Record<string, unknown>>;
