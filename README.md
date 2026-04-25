# Pass Chick

Pass Chick adalah game arcade risk-reward di Monad testnet dengan flow backend-authoritative.
Repo ini dibagi menjadi tiga bagian utama:

- `frontend/`: Next.js app untuk wallet connect, deposit, play, cashout, dan passport UI
- `backend/`: Express + Socket.io server untuk SIWE auth, game session, settlement signing, dan API player
- `sc/`: smart contracts Foundry untuk token mock, vault, settlement, faucet, dan trust passport

## Repo Structure

```text
.
├── frontend/
├── backend/
└── sc/
```

README per bagian:

- [frontend/README.md](./frontend/README.md)
- [backend/README.md](./backend/README.md)
- [sc/README.md](./sc/README.md)

## Current Testnet Contracts

Alamat proxy yang dipakai app saat ini:

- `GameUSDC`: `0x5631dF2e613141a4E57ca7BCD25e634825b16c7d`
- `USDCFaucet`: `0x52E02a81D373f3597D2d696299CA1ca1B278dfeF`
- `GameVault`: `0x45B893d50dfDC750Ab8d3696cAC5556A697153ca`
- `GameSettlement`: `0xD1873ddd24Cf2C41192e11a87CC7d3026557dab8`
- `TrustPassport`: `0x31029a59E40eb062f3C5D33AdFF8561F0549199e`

## Local Development

Jalankan tiap package di terminal terpisah.

### 1. Frontend

```bash
cd frontend
npm install
npm run dev
```

Default URL:

- `http://localhost:3000`

### 2. Backend

```bash
cd backend
npm install
npm run dev
```

Default URL:

- `http://localhost:8000`

### 3. Smart Contracts

```bash
cd sc
forge build
forge test --offline
```

## Environment Notes

Hal penting yang perlu sinkron antar package:

- `frontend/.env`
  - contract address proxy terbaru
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
  - signer backend
  - target address untuk rotation / upgrade script

## Important Notes

- Branding project sudah diganti ke `Pass Chick` di layer app/docs.
- Domain EIP-712 smart contract tidak ikut diubah agar kompatibilitas deployment live tetap aman.
- Public Monad RPC bisa kena rate limit. Untuk gameplay yang lebih stabil, gunakan RPC provider yang lebih longgar atau dedicated.
