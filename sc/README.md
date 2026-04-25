# Monad Game Contracts

Smart contract package ini menyiapkan flow backend-authoritative untuk game ayam di Monad testnet.
Semua kontrak deploy sebagai proxy UUPS (`ERC1967Proxy` + implementation terpisah):

- `GameUSDC`: mock USDC dengan 6 desimal
- `USDCFaucet`: faucet bootstrap dana testnet
- `GameVault`: custody layer dengan `available`, `locked`, dan `treasury`
- `GameSettlement`: session manager yang memverifikasi EIP-712 signature dari backend
- `TrustPassport`: credential onchain (tier + expiry) untuk anti-bot / proof-of-human flow

## Current Testnet Deployment

Proxy yang aktif dan sudah diverifikasi di MonadVision / Sourcify:

- `GameUSDC`: `0xAeffBE902D7e5c53fba1CB08a343E5C077605B4f`
- `USDCFaucet`: `0x35eCb74C54D3f2d1a7a4bFFd608B5598c39A63C7`
- `GameVault`: `0x3e80F71d5FfcbB9A5507e97D8262BC866430cdDd`
- `GameSettlement`: `0x2bE08dAe6C69ed133E5d91d0CE60bB54ad987e8F`
- `TrustPassport`: deploy baru via script `DeployGameContracts.s.sol`

## Contracts

### GameUSDC

- Name: `Mock USD Coin`
- Symbol: `USDC`
- Decimals: `6`
- Tidak ada initial supply
- Hanya address yang di-set sebagai minter yang bisa memanggil `mint`
- Upgradeable via UUPS, owner proxy berwenang melakukan upgrade

### USDCFaucet

- `claim()` mint `100 * 10^6` ke caller
- Tanpa cooldown
- Owner bisa `pause`, `unpause`, dan `setClaimAmount`
- Upgradeable via UUPS

### GameVault

- User melakukan `approve` ke vault lalu `deposit(amount)`
- Vault memisahkan saldo `availableBalance`, `lockedBalance`, dan `treasuryBalance`
- User hanya bisa `withdraw(amount)` dari `availableBalance`
- `fundTreasury(amount)` dipakai untuk bootstrap likuiditas payout
- Owner bisa `treasuryWithdraw(recipient, amount)` untuk menarik saldo treasury protokol
- Owner bisa `rescueToken(token, recipient, amount)` untuk menyelamatkan token nyasar; khusus `USDC`, hanya saldo berlebih yang tidak memback balance user/treasury yang bisa di-rescue
- Hanya `GameSettlement` yang boleh memanggil lock / settle stake
- Owner bisa `pause()` / `unpause()` untuk menghentikan deposit, treasury funding, dan operasi settlement di vault
- Upgradeable via UUPS

### GameSettlement

- `startSession(bytes32 onchainSessionId, uint256 stakeAmount)` mengunci stake dari vault
- Satu wallet hanya boleh punya satu session aktif
- `settleWithSignature(...)` memverifikasi payload EIP-712 dari backend
- `expireSession(bytes32 sessionId)` menutup sesi yang macet setelah timeout sebagai `CRASHED`
- Owner bisa `pause()` / `unpause()` untuk menghentikan start session dan settlement
- `sessionExpiryDelay` bisa dikonfigurasi owner
- Jika `CASHED_OUT`, payout masuk ke `availableBalance` internal user
- Jika `CRASHED`, stake masuk ke treasury
- Smart contract tidak menerima multiplier langsung dari client
- Upgradeable via UUPS

## Prerequisites

- Foundry terinstall
- RPC Monad testnet tersedia
- Private key deployer tersedia jika ingin broadcast deployment

## Environment

Tambahkan env berikut di `sc/.env`:

```bash
MONAD_RPC_URL=https://your-monad-testnet-rpc
PRIVATE_KEY=0xyour_private_key
INITIAL_OWNER=0xyour_owner_address
USDC_FAUCET_CLAIM_AMOUNT=100000000
BACKEND_SIGNER=0xyour_backend_signer_address
SESSION_EXPIRY_DELAY=86400
```

Minimal yang dibutuhkan untuk broadcast hanyalah `MONAD_RPC_URL` dan `PRIVATE_KEY`.
`PRIVATE_KEY` boleh memakai prefix `0x`.
`INITIAL_OWNER` opsional. Jika tidak diisi, deploy script memakai address dari `PRIVATE_KEY`.
`USDC_FAUCET_CLAIM_AMOUNT` opsional. Default-nya `100000000` atau `100 USDC` dengan 6 desimal.
`BACKEND_SIGNER` opsional. Jika tidak diisi, deploy script memakai `INITIAL_OWNER`.
`SESSION_EXPIRY_DELAY` opsional. Default-nya `86400` detik atau `1 hari`.
`GAME_SETTLEMENT_ADDRESS` dan `NEW_BACKEND_SIGNER` dipakai saat kamu ingin mengganti signer backend setelah deploy.
`TRUST_PASSPORT_ADDRESS` opsional untuk ikut mengganti signer backend pada kontrak passport.

## Commands

### Build

```bash
forge build
```

### Build For MonadVision / Sourcify

Untuk deployment baru yang ingin kompatibel dengan alur verifikasi MonadVision/Sourcify sesuai docs Monad,
pakai profile khusus ini:

```bash
FOUNDRY_PROFILE=monad_vision forge build
```

### Test

```bash
forge test --offline
```

### Format

```bash
forge fmt
```

## Deploy To Monad Testnet

### Standard Deploy

Ini memakai profile default repo saat ini:

Jika env sudah dimuat:

```bash
source .env
forge script script/DeployGameContracts.s.sol:DeployGameContracts --rpc-url "$MONAD_RPC_URL" --broadcast
```

Atau jika ingin tetap pakai argumen private key dari CLI:

```bash
forge script script/DeployGameContracts.s.sol:DeployGameContracts --rpc-url "$MONAD_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast
```

### Deploy For MonadVision / Sourcify

Kalau kamu ingin deployment baru yang sejak awal mengikuti konfigurasi yang direkomendasikan docs Monad untuk
MonadVision / Sourcify, gunakan:

```bash
source .env
FOUNDRY_PROFILE=monad_vision forge script script/DeployGameContracts.s.sol:DeployGameContracts --rpc-url "$MONAD_RPC_URL" --broadcast
```

Script deploy akan:

- deploy implementation `GameUSDC`, `USDCFaucet`, `GameVault`, `GameSettlement`
- deploy implementation `TrustPassport`
- deploy proxy UUPS untuk masing-masing kontrak
- grant minter role dari token ke faucet
- set `GameSettlement` sebagai operator resmi di `GameVault`
- print alamat hasil deploy

Output penting untuk frontend:

```bash
NEXT_PUBLIC_USDC_ADDRESS=<deployed_game_usdc>
NEXT_PUBLIC_GAME_VAULT_ADDRESS=<deployed_game_vault>
NEXT_PUBLIC_GAME_SETTLEMENT_ADDRESS=<deployed_game_settlement>
NEXT_PUBLIC_TRUST_PASSPORT_ADDRESS=<deployed_trust_passport>
```

Alamat yang dipakai frontend adalah alamat proxy, bukan implementation.

## Verification

### Current Live Deployment

Deployment yang sedang live saat ini sudah berhasil diverifikasi melalui explorer gaya Etherscan
(`Monadscan` / `Socialscan`).

Kalau alamat yang sama belum muncul sebagai verified di `MonadVision`, penyebab paling mungkin adalah deployment itu
dibuat sebelum repo ini memakai konfigurasi yang direkomendasikan Sourcify / MonadVision.
Perubahan config setelah kontrak terlanjur live tidak bisa mengubah metadata bytecode kontrak yang sudah terdeploy.

Artinya:

- deployment live sekarang: sudah verified di `Monadscan` / `Socialscan`
- deployment baru dengan `FOUNDRY_PROFILE=monad_vision`: disiapkan supaya cocok dengan alur `MonadVision / Sourcify`

### Verify On MonadVision / Sourcify

Untuk deployment baru yang dibangun dengan profile `monad_vision`, gunakan pola resmi docs Monad:

```bash
FOUNDRY_PROFILE=monad_vision forge verify-contract \
  <contract_address> \
  <contract_name> \
  --chain 10143 \
  --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org/
```

### Verify On Monadscan / Socialscan

Untuk explorer yang memakai flow `etherscan`, gunakan:

```bash
forge verify-contract \
  <contract_address> \
  <contract_name> \
  --chain 10143 \
  --watch \
  --etherscan-api-key test \
  --verifier-url https://api.socialscan.io/monad-testnet/v1/explorer/command_api/contract \
  --verifier etherscan
```

## Rotate Backend Signer

Kalau wallet backend berbeda dari wallet deployer / owner, update signer onchain dengan script ini:

Tambahkan env berikut di `sc/.env`:

```bash
GAME_SETTLEMENT_ADDRESS=0xyour_game_settlement_proxy
NEW_BACKEND_SIGNER=0xyour_new_backend_signer_address
```

Lalu jalankan:

```bash
source .env
forge script script/UpdateBackendSigner.s.sol:UpdateBackendSigner --rpc-url "$MONAD_RPC_URL" --broadcast
```

Script ini memanggil `setBackendSigner(newBackendSigner)` pada proxy `GameSettlement`.
Pastikan `PRIVATE_KEY` yang dipakai adalah owner kontrak `GameSettlement`.

## Flow Backend-Authoritative

1. User `approve USDC` lalu `deposit(amount)` ke vault.
2. Backend membuat `onchain_session_id` untuk ronde game.
3. Frontend memanggil `GameSettlement.startSession(onchainSessionId, stakeAmount)`.
4. Backend memvalidasi hasil game offchain lalu menandatangani payload `Resolution` via EIP-712.
5. Frontend / keeper memanggil `settleWithSignature(...)`.
6. Jika cashout berhasil, payout masuk ke `availableBalance` internal user.
7. User bisa langsung memakai lagi seluruh `availableBalance` untuk ronde berikutnya, atau `withdraw(amount)` ke wallet kapan saja.
8. Jika sesi macet dan tidak pernah di-settle, siapa pun bisa memanggil `expireSession(...)` setelah timeout untuk menutup sesi sebagai crash.

## Frontend Wiring

- `NEXT_PUBLIC_USDC_ADDRESS`
- `NEXT_PUBLIC_GAME_VAULT_ADDRESS`
- `NEXT_PUBLIC_GAME_SETTLEMENT_ADDRESS`
- `NEXT_PUBLIC_TRUST_PASSPORT_ADDRESS`

Frontend deposit dan game flow nantinya bisa memakai urutan:

1. `approve(USDC, GameVault, amount)`
2. `deposit(amount)`
3. `startSession(onchainSessionId, stakeAmount)`
4. `settleWithSignature(resolution, signature)`
5. `withdraw(amount)`
