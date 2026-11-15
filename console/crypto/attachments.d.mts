export const ATTACHMENT_PROFILE: 'attachment-chunked-aead@0.1.0';
export const MIN_CHUNK_SIZE: number;
export const MAX_CHUNK_SIZE: number;
export const MAX_FILE_SIZE: number;
export interface PrivateAttachmentManifest {
  format_version: 1; profile: typeof ATTACHMENT_PROFILE; attachment_id: string;
  parent_message_id: string; key_id: string; attachment_key_hex: string;
  aead: 'ALG-AES-256-GCM'; hash: 'ALG-SHA-256'; nonce_prefix_hex: string;
  chunk_size_bytes: number; chunk_count: number; plaintext_size_bytes: number;
  filename: string; media_type: string; plaintext_hash_hex: string;
  storage_object_id: string; manifest_context_digest_hex: string;
}
export function validatePrivateManifest(input: unknown, expectedParentMessageId: string): Readonly<PrivateAttachmentManifest>;
export function prepareAttachment(blob: Blob, options: {
  parentMessageId: string; filename: string; mediaType?: string; chunkSize?: number; signal?: AbortSignal;
}): Promise<Readonly<{
  privateManifest: Readonly<PrivateAttachmentManifest>;
  encryptTo(writeCiphertext: (index: number, ciphertext: Uint8Array) => void | Promise<void>): Promise<Readonly<{ ciphertextComplete: true; chunks: number }>>;
}>>;
export function openAttachment(input: unknown, expectedParentMessageId: string): Promise<Readonly<{
  decryptChunk(index: number, ciphertext: Uint8Array): Promise<Uint8Array>;
  decryptTo(readCiphertext: (index: number) => Uint8Array | Promise<Uint8Array>,
    writeAuthenticatedChunk: (index: number, plaintext: Uint8Array) => void | Promise<void>,
    options?: { signal?: AbortSignal }): Promise<Readonly<{ wholeFileVerified: true; chunks: number; plaintextBytes: number }>>;
}>>;
export function resumeAttachment(blob: Blob, manifest: unknown, expectedParentMessageId: string, options?: { signal?: AbortSignal }): Promise<Readonly<{
  privateManifest: Readonly<PrivateAttachmentManifest>;
  encryptMissing(skip: Set<number>, writeCiphertext: (index: number, ciphertext: Uint8Array) => void | Promise<void>): Promise<Readonly<{ ciphertextComplete: true; chunks: number }>>;
}>>;
