# Pass Chick Backend

Backend Pass Chick menangani flow server-authoritative untuk game dan auth.

Tanggung jawab utama:

- SIWE authentication
- session cookie management
- realtime game loop via Socket.io
- settlement signing
- settlement relaying onchain
- leaderboard / player API
- trust passport eligibility dan signature issuance

## Stack

- Express
- Socket.io
- Viem
- SIWE
- Supabase

## Commands

```bash
npm install
npm run dev
npm run build
npm run start
```

## Runtime

Default local config:

- backend URL: `http://localhost:8000`
- expected frontend origin: `http://localhost:3000`

## Required Environment

Backend membaca env dari `backend/.env`.

Field utama:

```bash
PORT=8000
FRONTEND_URL=http://localhost:3000

SESSION_SECRET=your_session_secret

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

MONAD_RPC_URL=https://your-monad-rpc
MONAD_CHAIN_ID=10143

GAME_VAULT_ADDRESS=0x...
GAME_SETTLEMENT_ADDRESS=0x...
TRUST_PASSPORT_ADDRESS=0x...

BACKEND_PRIVATE_KEY=0x...

SETTLEMENT_SIGNATURE_TTL_SECONDS=86400
PASSPORT_SIGNATURE_TTL_SECONDS=900
PASSPORT_VALIDITY_SECONDS=2592000
```

## Current Contract Wiring

Alamat proxy yang dipakai backend saat ini:

- `GAME_VAULT_ADDRESS=0x45B893d50dfDC750Ab8d3696cAC5556A697153ca`
- `GAME_SETTLEMENT_ADDRESS=0xD1873ddd24Cf2C41192e11a87CC7d3026557dab8`
- `TRUST_PASSPORT_ADDRESS=0x31029a59E40eb062f3C5D33AdFF8561F0549199e`

Backend signer saat ini harus sinkron dengan signer onchain untuk:

- settlement signature
- passport signature

## Important Routes

Auth:

- `GET /auth/nonce`
- `POST /auth/verify`
- `POST /auth/logout`
- `GET /auth/me`

Game / player:

- `GET /api/game/active`
- `GET /api/game/pending-settlement`
- `POST /api/game/submit-settlement`
- `GET /api/leaderboard/...`
- `GET /api/player/...`

Passport:

- `GET /api/passport/status`
- `POST /api/passport/issue-signature`

Health:

- `GET /health`

## Common Issues

### Frontend tidak bisa auth

Cek:

- backend benar-benar hidup di port yang sama dengan `NEXT_PUBLIC_BACKEND_API_URL`
- `FRONTEND_URL` backend cocok dengan origin frontend
- browser mengizinkan cookie untuk local dev flow

### Cashout gagal

Penyebab umum:

- relayer backend kehabisan `MON` untuk gas
- RPC Monad gagal / rate limit
- signer backend tidak cocok dengan `backendSigner` onchain
- treasury vault tidak cukup untuk payout

Backend sekarang sudah memetakan error settlement ke pesan yang lebih spesifik agar debugging lebih mudah.

## Database

Schema Supabase ada di:

- [database/schema.sql](./database/schema.sql)
