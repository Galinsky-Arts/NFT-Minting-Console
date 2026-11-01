export interface DraftTransport {
  (path: string, options?: { method?: string; body?: unknown }): Promise<unknown>;
}
export function createEncryptedRelease(draft: Record<string, unknown>, options: {
  id: string; wrappingKey: CryptoKey; request: DraftTransport;
}): Promise<Readonly<{ id: string; revision: string; created: boolean }>>;
export function readEncryptedRelease(id: string, options: {
  wrappingKey: CryptoKey; request: DraftTransport; minimumRevision?: string;
}): Promise<Readonly<{ id: string; revision: string; draft: Record<string, unknown> }>>;
export function updateEncryptedRelease(draft: Record<string, unknown>, options: {
  id: string; expectedRevision: string; wrappingKey: CryptoKey; request: DraftTransport;
}): Promise<Readonly<{ id: string; revision: string }>>;
