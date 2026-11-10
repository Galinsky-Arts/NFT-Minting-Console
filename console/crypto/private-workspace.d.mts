export type Request = (path: string, options: { method?: string; body?: unknown; raw?: Uint8Array; binary?: boolean; signal?: AbortSignal }) => Promise<any>;
export interface DeviceStore { get(key: string): Promise<any>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> }
export interface UploadedFile { blobId: string; manifest: Record<string, unknown> & { chunk_count: number; plaintext_size_bytes: number; plaintext_hash_hex: string; media_type: string; filename: string } }
export interface Progress { phase: 'prepared' | 'uploading' | 'complete'; manifest: UploadedFile['manifest']; blobId: string; done: number; total: number }
export interface DeviceInfo { id: string; label: string; state: 'pending' | 'active' | 'revoked'; publicKey: string; wrappedEpoch: number | null; createdAt: string; revokedAt: string | null }
export interface WorkspaceStatus { exists: boolean; keyEpoch?: number; devices: DeviceInfo[]; device?: (DeviceInfo & { wrappedKey: string | null }) | null; localDevice: { id: string; label: string; fingerprint: string } | null }
export class WorkspaceError extends Error { code: string }
export function fingerprint(publicKey: Uint8Array): Promise<string>;
export function unb64(value: string): Uint8Array;
export function b64(bytes: Uint8Array): string;
export function indexedDbDeviceStore(name?: string): DeviceStore;
export function memoryDeviceStore(): DeviceStore;
export class PrivateWorkspace {
  constructor(options: { request: Request; wallet: string; chainId: number; deviceStore: DeviceStore });
  readonly unlocked: boolean; readonly epoch: number;
  lock(): void;
  status(): Promise<WorkspaceStatus>;
  create(label: string): Promise<{ recoveryCode: string; deviceId: string }>;
  unlock(): Promise<unknown>;
  requestAccess(label: string): Promise<{ deviceId: string; fingerprint: string }>;
  approve(pending: DeviceInfo, confirmedFingerprint: string): Promise<unknown>;
  recover(code: string, label: string): Promise<{ deviceId: string }>;
  revoke(deviceId: string): Promise<{ recoveryCode: string; keyEpoch: number }>;
  rotateRecoveryCode(): Promise<string>;
  list(): Promise<{ id: string; kind: 'release' | 'configuration'; revision: number; keyEpoch: number; archived: boolean; bytes: number; updatedAt: string }[]>;
  load(id: string): Promise<any>;
  save(id: string, kind: 'release' | 'configuration', value: unknown, expectedRevision: number, options?: { archived?: boolean }): Promise<number>;
  uploadFile(file: File, options: { recordId: string; onProgress?: (p: Progress) => void; signal?: AbortSignal; resume?: { manifest: unknown; blobId: string } | null; chunkSize?: number }): Promise<UploadedFile>;
  downloadFile(file: UploadedFile, recordId: string, options?: { onProgress?: (p: { done: number; total: number }) => void; signal?: AbortSignal }): Promise<Blob>;
}
