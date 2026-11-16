# NFT Console - Owner Quick Start

Your console is running at **https://nft-minting-console.onrender.com** on the Ethereum **Sepolia test
network**. Everything below uses test ETH only. Nobody but you can sign transactions: the console never
holds your wallet keys, and every deployment, mint and listing is approved in your own wallet.

## What you need

- A browser wallet (for example MetaMask or Rabby) with an address you control.
- Your Render login (Render dashboard, service **nft-minting-console**).
- About 0.05 Sepolia test ETH from any Sepolia faucet.
- About 30 minutes.

## Step 1 - Connect the console to the blockchain (RPC_URL)

The site currently shows **"Blockchain connection not configured"**. That is expected.

1. Create a free account at Alchemy, Infura or QuickNode and create a **Sepolia** endpoint. Copy its
   **HTTPS** URL.
2. In Render: open **nft-minting-console** > **Environment** > **Add Environment Variable**.
   Key `RPC_URL`, value the HTTPS URL. Save. The service restarts by itself (1-3 minutes).
3. Reload the site. The warning is replaced by the administrator registration screen.

## Step 2 - Register yourself as administrator (NFT_SETUP_CODE)

1. In Render > **Environment**, reveal and copy the value of `NFT_SETUP_CODE` (64 characters).
2. On the site, connect your wallet, switch it to Sepolia, paste the setup code and sign the message.
   Signing a message costs nothing and sends no transaction.
3. You are now the administrator. The setup code cannot be used again, even by someone who copies it.

## Step 3 - Deploy the collection factory (once)

The factory is a small contract that creates your collections. It is deployed once per network, from
your wallet, using the guided helper:

1. On a computer with Node.js 22: download the repository, then run `npm ci` and `npm run compile`.
2. Run `RPC_URL=<your URL> OWNER_WALLET=<your address> npm run rehearse:sepolia -- --sign-factory`.
3. Open the `http://127.0.0.1:...` link it prints, click **Connect wallet and deploy**, approve the
   transaction in your wallet, and wait for **"Factory verified at 0x..."**.
4. In Render > **Environment**, add `DEPLOYMENT_FACTORY_ADDRESS` with that address and save.

Full detail: `docs/SEPOLIA_REHEARSAL.md`.

## Step 4 - Create a collection

1. Open **Create release**. Enter the collection name, symbol, supply, sale price and royalty.
2. Add artwork and rights details. Anything you keep in **Private workspace** is encrypted in your
   browser before it is uploaded.
3. Check **Release readiness** and fix anything it lists as missing.

## Step 5 - Deploy on Sepolia and mint

1. Open **Deploy & mint**. Review the total cost summary (gas is paid in test ETH).
2. Click deploy and approve in your wallet. The console checks the result on chain.
3. Mint a test token and approve in your wallet. **Mint transactions** shows each receipt.

## Step 6 - List

Open **Marketplace**, choose the token and price, review, and sign the listing in your wallet.
On Sepolia this creates a signed Seaport order only; OpenSea does not show Sepolia items. Listing on
OpenSea itself is for Ethereum mainnet (see "Going live" below).

## Optional keys and what they unlock

Add these in Render > **Environment** only when you need them. Never paste them in chat or email.

| Key | Unlocks | Needed for |
| --- | --- | --- |
| `RPC_URL` | Sign-in, deployment, minting, listing - every blockchain feature | Required (Step 1) |
| `DEPLOYMENT_FACTORY_ADDRESS` | The **Deploy** button | Required to deploy (Step 3) |
| `PINATA_JWT` | Publishing artwork and metadata to IPFS from the browser | Public releases |
| `OPENSEA_API_KEY` | Submitting and verifying OpenSea listings | Mainnet only |
| `PRIVATE_STORAGE_*` (driver, endpoint, bucket, region, access key, secret) | Large encrypted private files in your own S3/R2 bucket instead of the database | Optional; see `docs/PRIVATE_OBJECT_STORAGE.md` |
| GitHub secret `NEON_API_KEY` | Weekly automatic database backups | Recommended; see `docs/BACKUP_AND_ALERTS.md` |

## Staying safe

- Only approve wallet requests you started yourself, on the network you expect (Sepolia while testing).
- Keep your private workspace recovery phrase offline. Without it, encrypted drafts cannot be recovered.
- Watch the GitHub repository to get email if the uptime check opens an **uptime-alert** issue.
- A database backup exists (`backup-2026-11-16-0058-drill`); restore steps are in `docs/BACKUP_AND_ALERTS.md`.

## Going live (Ethereum mainnet)

Do the Sepolia steps first. Mainnet uses real money and needs a separate decision: a small disposable
mainnet rehearsal (deploy, mint, list and buy one cheap test NFT), `CHAIN_ID=1`, the acknowledgement
`NFT_MAINNET_ACK=ethereum-mainnet-real-fees`, a mainnet `RPC_URL`, a mainnet factory and
`OPENSEA_API_KEY`. The contracts and console have had AI-assisted review and automated tests only; no
external security audit has been performed.

## Getting help

`docs/HANDOFF.md` describes how everything fits together and what remains. Any developer can take over
from the repository alone.
