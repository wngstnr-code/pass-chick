# Pass Chick Frontend

Frontend Pass Chick dibangun dengan Next.js dan menjadi UI utama untuk:

- connect wallet
- SIWE auth ke backend
- claim faucet
- deposit ke vault
- start run
- cashout / settle
- trust passport flow

## Stack

- Next.js 14
- React 18
- Wagmi
- Viem
- Reown AppKit
- Socket.io client

## Commands

```bash
npm install
npm run dev
npm run build
npm run start
```

## Required Environment

Contoh file ada di `frontend/.env.example`.

Minimal env yang dipakai:

```bash
NEXT_PUBLIC_MONAD_CHAIN_ID=0x279F
NEXT_PUBLIC_MONAD_CHAIN_NAME=Monad Testnet
NEXT_PUBLIC_MONAD_RPC_URLS=https://your-monad-rpc
NEXT_PUBLIC_MONAD_EXPLORER_URLS=https://your-explorer
NEXT_PUBLIC_MONAD_NATIVE_NAME=MON
NEXT_PUBLIC_MONAD_NATIVE_SYMBOL=MON
NEXT_PUBLIC_MONAD_NATIVE_DECIMALS=18

NEXT_PUBLIC_USDC_ADDRESS=0x...
NEXT_PUBLIC_USDC_FAUCET_ADDRESS=0x...
NEXT_PUBLIC_GAME_VAULT_ADDRESS=0x...
NEXT_PUBLIC_GAME_SETTLEMENT_ADDRESS=0x...
NEXT_PUBLIC_TRUST_PASSPORT_ADDRESS=0x...

NEXT_PUBLIC_DEPOSIT_DATA_SOURCE=onchain
NEXT_PUBLIC_BACKEND_API_URL=http://localhost:8000
NEXT_PUBLIC_REOWN_PROJECT_ID=your_reown_project_id
```

## Current Local Defaults

Repo ini saat ini memakai:

- frontend app: `http://localhost:3000`
- backend API: `http://localhost:8000`

## Current Contract Wiring

Alamat proxy yang dipakai frontend saat ini:

- `NEXT_PUBLIC_USDC_ADDRESS=0x5631dF2e613141a4E57ca7BCD25e634825b16c7d`
- `NEXT_PUBLIC_USDC_FAUCET_ADDRESS=0x52E02a81D373f3597D2d696299CA1ca1B278dfeF`
- `NEXT_PUBLIC_GAME_VAULT_ADDRESS=0x45B893d50dfDC750Ab8d3696cAC5556A697153ca`
- `NEXT_PUBLIC_GAME_SETTLEMENT_ADDRESS=0xD1873ddd24Cf2C41192e11a87CC7d3026557dab8`
- `NEXT_PUBLIC_TRUST_PASSPORT_ADDRESS=0x31029a59E40eb062f3C5D33AdFF8561F0549199e`

## Common Issues

### Wallet connect gagal

Cek:

- `NEXT_PUBLIC_REOWN_PROJECT_ID` valid
- wallet sudah switch ke Monad Testnet
- frontend sudah di-restart setelah perubahan `.env`

### Auth backend gagal

Cek:

- backend hidup di `http://localhost:8000`
- `NEXT_PUBLIC_BACKEND_API_URL` sesuai
- `FRONTEND_URL` di backend cocok dengan origin frontend

### RPC rate limit

Kalau muncul error seperti `requests limited to 15/sec`, itu berasal dari RPC publik Monad.
Solusi paling baik adalah memakai RPC provider yang lebih kuat untuk frontend dan backend.

## Build Status

Frontend saat ini bisa di-build dengan:

```bash
npm run build
```

Warning Reown saat build di environment tanpa akses internet masih bisa muncul, tapi itu bukan kegagalan compile app.
