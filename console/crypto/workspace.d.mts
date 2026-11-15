export type GroupState = { readonly __mlsGroup: unique symbol };
export interface AccountRoot { secretKey: string; publicKey: string }
export interface DeviceKeys { deviceId: string; signKey: string; publicKey: string }
export interface DeviceCertificate { v: 1; deviceId: string; signaturePublicKey: string; issuedAt: string; root: string; signature: string }
export interface KeyPackageBundle { publicPackage: string; privatePackage: unknown; keyPackage: unknown }
export interface SealedVault { format: string; profile: string; vaultId: string; version: number; kdf: Record<string, unknown>; nonce: string; ciphertext: string; purpose?: string }
export interface SealedDraft { draftId: string; revision: number; previousHash: string | null; nonce: string; ciphertext: string; contentHash: string }
export const VAULT_PROFILE: string;
export const MLS_PROFILE: string;
export const MLS_SUITE: string;
export class WorkspaceCryptoError extends Error { code: string }
export function random(n: number): Uint8Array;
export function b64(u: Uint8Array): string;
export function unb64(s: string): Uint8Array;
export function newId(): string;
export function canonical(value: unknown): string;
export function createVault(passphrase: string, state: unknown): Promise<{ key: Uint8Array; sealed: SealedVault }>;
export function openVault(passphrase: string, sealed: SealedVault): Promise<{ key: Uint8Array; state: any }>;
export function openVaultWithKey(key: Uint8Array, sealed: SealedVault): any;
export function resealVault(key: Uint8Array, sealed: SealedVault, state: unknown): SealedVault;
export function createAccountRoot(): AccountRoot;
export function certifyDevice(root: AccountRoot, input: { deviceId: string; signaturePublicKey: Uint8Array; issuedAt?: string }): DeviceCertificate;
export function verifyDeviceCert(rootPublicKey: string, cert: unknown, signaturePublicKey?: Uint8Array): boolean;
export function newDeviceKeys(): Promise<DeviceKeys>;
export function keyPackageFor(device: DeviceKeys, cert: DeviceCertificate): Promise<KeyPackageBundle>;
export function saveGroup(state: GroupState): string;
export function loadGroup(saved: string, rootPublicKey: string): GroupState;
export function epochOf(state: GroupState): string;
export function createWorkspaceGroup(rootPublicKey: string, kp: KeyPackageBundle): Promise<GroupState>;
export function inspectKeyPackage(rootPublicKey: string, encoded: string): { deviceId: string; cert: DeviceCertificate; keyPackage: unknown };
export function addDevice(state: GroupState, rootPublicKey: string, encodedKeyPackage: string): Promise<{ state: GroupState; commit: string; welcome: string; epoch: string; deviceId: string }>;
export function removeDevice(state: GroupState, deviceId: string): Promise<{ state: GroupState; commit: string; epoch: string }>;
export function joinWorkspace(rootPublicKey: string, welcome: string, kp: KeyPackageBundle): Promise<GroupState>;
export function memberDevices(state: GroupState): string[];
export function sendToMembers(state: GroupState, payload: unknown): Promise<{ state: GroupState; message: string; epoch: string }>;
export function receive(state: GroupState, encoded: string): Promise<{ state: GroupState; payload: any }>;
export function newDraftKey(): string;
export function encryptDraft(key: string, header: { draftId: string; revision: number; previousHash: string | null }, document: unknown): SealedDraft;
export function decryptDraft(key: string, sealed: SealedDraft, expected?: { draftId?: string; revision?: number }): any;
export function newRecoveryCode(): string;
export function createRecoveryBackup(code: string, input: { root: AccountRoot; draftKeys: Record<string, string>; accountWallet: string }): Promise<SealedVault>;
export function openRecoveryBackup(code: string, backup: SealedVault): Promise<{ root: AccountRoot; draftKeys: Record<string, string>; accountWallet: string }>;
export function fingerprint(publicKeyB64: string): string;
export function signReset(root: AccountRoot, input: { wallet: string; chainId: number; generation: number; deviceId: string }): { reset: Record<string, unknown>; signature: string };
