import { HDNodeWallet, getCreateAddress } from 'ethers';
// Public Hardhat mnemonic for this disposable local EVM only. Never use these
// accounts on a public network or with user funds. No user wallet is loaded.
const mnemonic = 'test test test test test test test test test test test junk';
export const testWallets = Array.from({ length: 10 }, (_, i) => HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i}`));
export const OWNER = testWallets[0].address;
export const VIEWER = testWallets[1].address;
export const EDITOR = testWallets[2].address;
// The fixture deploys singleton, fallback handler, then proxy. Startup verifies
// this deterministic address against the actual deployed proxy, not an assumption.
export const SAFE = getCreateAddress({ from: OWNER, nonce: 2 });
export const ORIGIN = 'http://127.0.0.1:4173';
