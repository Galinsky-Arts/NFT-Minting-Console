/** Browser-local, non-extractable key. No cross-device recovery is implied. */
export function loadLocalReleaseKey(wallet: string, chainId: number): Promise<CryptoKey | null>;
export function createLocalReleaseKey(wallet: string, chainId: number): Promise<CryptoKey>;
