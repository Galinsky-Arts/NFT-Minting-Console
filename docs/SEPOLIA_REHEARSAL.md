# Sepolia rehearsal (NFT-22)

One command runs everything that can run without the owner, then stops at the first step that needs
the owner's RPC endpoint or wallet signature:

```bash
npm ci && npm run compile
npm run rehearse:sepolia
```

| Step | Runs when | What it does | Sends transactions? |
| --- | --- | --- | --- |
| 1. Local rehearsal | always (skip with `--skip-local`) | Disposable Hardhat chain 31337: factory, two collections, four mint batches, 24 verified token mints | Only on the throwaway local chain, with public test-fixture keys |
| 2. Sepolia preflight | `RPC_URL` set | Chain is 11155111, head fresh, fee level, `OWNER_WALLET` test-ETH balance, factory identity (`DEPLOYMENT_FACTORY_ADDRESS`) or factory deployment cost estimate | No (read-only RPC calls) |
| 3. Factory deployment | `--sign-factory` | Opens a page on `127.0.0.1` that asks **your browser wallet** to deploy the factory; then verifies the receipt and bytecode | Only if you approve it in your wallet |
| 4. Evidence | `--verify-tx HASH,...` (`--write` to save) | Reads receipts of transactions you signed in the app and writes `docs/evidence/sepolia-rehearsal-DATE.json` | No |

The script refuses to start if any `*PRIVATE_KEY*`, `MNEMONIC` or seed-phrase variable is set: there is
no code path in which it can sign. Every Sepolia transaction is approved by the owner in their wallet.

## Owner steps (about 30 minutes, test ETH only)

1. **Get a Sepolia RPC URL.** Create a free key at Alchemy, Infura or QuickNode and copy the HTTPS
   Sepolia endpoint. Add it in Render > `nft-minting-console` > Environment as `RPC_URL`.
2. **Get test ETH.** Use any Sepolia faucet for your wallet address (about 0.05 SepoliaETH is plenty).
3. **Preflight** on your computer (clone the repo first):
   `RPC_URL=https://... OWNER_WALLET=0xYourAddress npm run rehearse:sepolia`
   All checks should be `pass`; `factory` shows `owner-action` until step 4.
4. **Deploy the factory** (once per chain):
   `RPC_URL=https://... OWNER_WALLET=0xYourAddress npm run rehearse:sepolia -- --skip-local --sign-factory`
   Open the printed `http://127.0.0.1:...` link in the browser with your wallet, approve the one
   transaction on Sepolia, and wait for "Factory verified at 0x...".
5. Add that address in Render as `DEPLOYMENT_FACTORY_ADDRESS` and let the service restart.
6. **In the app** (https://nft-minting-console.onrender.com): register as administrator with
   `NFT_SETUP_CODE` (first visit only), create a collection, deploy it, mint a test token and create a
   listing; optionally send the token to a second address from your wallet. Each step asks your wallet to sign. Copy the
   transaction hashes from the app or your wallet history.
7. **Record evidence:**
   `RPC_URL=https://... npm run rehearse:sepolia -- --skip-local --verify-tx 0xHASH1,0xHASH2 --write`
   and commit the generated `docs/evidence/sepolia-rehearsal-DATE.json`.

OpenSea does not index Sepolia; a Sepolia listing is a signed Seaport order only. The marketplace and
royalty-payout rehearsal is the separate disposable-mainnet package (NFT-33).

## Status

- Local rehearsal: passes in CI (`npm run mint:rehearse`) and through `npm run rehearse:sepolia`.
- Sepolia: **not yet performed** - needs the owner's `RPC_URL`, test ETH and wallet signatures.
  The preflight, signing page and receipt recorder are covered by `test-ops/sepolia-rehearsal.test.mjs`
  with a read-only fake provider that fails on any send attempt. They have not run against a live
  Sepolia RPC from the development sandbox (outbound RPC hosts are blocked there).
