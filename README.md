# Pass Chick

Pass Chick is a risk-reward arcade game built on Monad testnet with a backend-authoritative game flow.
This repository is split into three main packages:

- `frontend/`: Next.js app for wallet connect, deposit, gameplay, cashout, and passport UX
- `backend/`: Express + Socket.io server for SIWE auth, game sessions, settlement signing, and player APIs
- `sc/`: Foundry smart contracts for the mock token, faucet, vault, settlement, and trust passport

## Live Deployment

- App: https://pass-chick.vercel.app/

## Repository Structure

```text
.
├── frontend/
├── backend/
└── sc/
```

Package-level docs:

- [frontend/README.md](./frontend/README.md)
- [backend/README.md](./backend/README.md)
- [sc/README.md](./sc/README.md)

## Current Testnet Contracts

The app currently points to these proxy addresses:

- `GameUSDC`: `0x5631dF2e613141a4E57ca7BCD25e634825b16c7d`
- `USDCFaucet`: `0x52E02a81D373f3597D2d696299CA1ca1B278dfeF`
- `GameVault`: `0x45B893d50dfDC750Ab8d3696cAC5556A697153ca`
- `GameSettlement`: `0xD1873ddd24Cf2C41192e11a87CC7d3026557dab8`
- `TrustPassport`: `0x31029a59E40eb062f3C5D33AdFF8561F0549199e`

## Local Development

Run each package in a separate terminal.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Default URL:

- `http://localhost:3000`

### Backend

```bash
cd backend
npm install
npm run dev
```

Default URL:

- `http://localhost:8000`

### Smart Contracts

```bash
cd sc
forge build
forge test --offline
```

## Environment Notes

These values need to stay in sync across packages:

- `frontend/.env`
  - latest proxy addresses
  - `NEXT_PUBLIC_BACKEND_API_URL`
  - `NEXT_PUBLIC_REOWN_PROJECT_ID`
- `backend/.env`
  - `MONAD_RPC_URL`
  - `GAME_VAULT_ADDRESS`
  - `GAME_SETTLEMENT_ADDRESS`
  - `TRUST_PASSPORT_ADDRESS`
  - `BACKEND_PRIVATE_KEY`
- `sc/.env`
  - deployer key
  - owner
  - backend signer
  - target addresses for signer rotation or upgrades

## Important Notes

- The product branding has been updated to `Pass Chick` in the app and docs layers.
- The onchain EIP-712 domain names were intentionally left unchanged to preserve compatibility with the live deployment.
- Public Monad RPC endpoints can be rate-limited. For more stable gameplay, use a stronger or dedicated RPC provider.
