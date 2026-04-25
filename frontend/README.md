# Pass Chick Frontend

The Pass Chick frontend is a Next.js application that handles:

- wallet connection
- SIWE authentication against the backend
- faucet claim
- vault deposit
- gameplay start and cashout
- trust passport UX

## Live Deployment

- App: https://pass-chick.vercel.app/

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

Example values live in `frontend/.env.example`.

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

- frontend app: `http://localhost:3000`
- backend API: `http://localhost:8000`

## Current Contract Wiring

- `NEXT_PUBLIC_USDC_ADDRESS=0x5631dF2e613141a4E57ca7BCD25e634825b16c7d`
- `NEXT_PUBLIC_USDC_FAUCET_ADDRESS=0x52E02a81D373f3597D2d696299CA1ca1B278dfeF`
- `NEXT_PUBLIC_GAME_VAULT_ADDRESS=0x45B893d50dfDC750Ab8d3696cAC5556A697153ca`
- `NEXT_PUBLIC_GAME_SETTLEMENT_ADDRESS=0xD1873ddd24Cf2C41192e11a87CC7d3026557dab8`
- `NEXT_PUBLIC_TRUST_PASSPORT_ADDRESS=0x31029a59E40eb062f3C5D33AdFF8561F0549199e`

## Common Issues

### Wallet connection fails

Check:

- `NEXT_PUBLIC_REOWN_PROJECT_ID` is valid
- the wallet is switched to Monad Testnet
- the frontend was restarted after `.env` changes

### Backend auth fails

Check:

- the backend is running on `http://localhost:8000`
- `NEXT_PUBLIC_BACKEND_API_URL` matches the actual backend URL
- `FRONTEND_URL` in the backend matches the frontend origin

### RPC rate limits

If you see errors such as `requests limited to 15/sec`, the issue comes from the public Monad RPC.
The best fix is to use a stronger RPC provider for both frontend and backend.

## Build

```bash
npm run build
```

Reown warnings can still appear during build in restricted environments, but they do not necessarily mean the frontend failed to compile.
