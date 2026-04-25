# Pass Chick Smart Contracts

This package contains the backend-authoritative onchain flow for Pass Chick on Monad testnet.
All contracts are deployed as UUPS proxies (`ERC1967Proxy` + separate implementations).

Included contracts:

- `GameUSDC`: mock USDC with 6 decimals
- `USDCFaucet`: testnet bootstrap faucet
- `GameVault`: custody layer for available, locked, and treasury balances
- `GameSettlement`: session manager that verifies backend EIP-712 signatures
- `TrustPassport`: onchain credential for anti-bot / proof-of-human style flows

## Current Testnet Deployment

Verified proxy addresses:

- `GameUSDC`: `0x5631dF2e613141a4E57ca7BCD25e634825b16c7d`
- `USDCFaucet`: `0x52E02a81D373f3597D2d696299CA1ca1B278dfeF`
- `GameVault`: `0x45B893d50dfDC750Ab8d3696cAC5556A697153ca`
- `GameSettlement`: `0xD1873ddd24Cf2C41192e11a87CC7d3026557dab8`
- `TrustPassport`: `0x31029a59E40eb062f3C5D33AdFF8561F0549199e`

## Contract Summary

### GameUSDC

- Name: `Mock USD Coin`
- Symbol: `USDC`
- Decimals: `6`
- No initial supply
- Only approved minters can call `mint`
- Upgradeable through UUPS

### USDCFaucet

- `claim()` mints `100 * 10^6` to the caller
- No cooldown
- Owner can `pause`, `unpause`, and `setClaimAmount`
- Upgradeable through UUPS

### GameVault

- Users `approve` USDC and then call `deposit(amount)`
- Tracks `available`, `locked`, and `treasury` balances separately
- Users can only `withdraw(amount)` from their available balance
- `fundTreasury(amount)` is used to bootstrap payout liquidity
- Owner can withdraw treasury funds and rescue stray tokens
- Only `GameSettlement` can lock stake and settle outcomes
- Upgradeable through UUPS

### GameSettlement

- `startSession(bytes32 onchainSessionId, uint256 stakeAmount)` locks stake in the vault
- One wallet can only have one active session at a time
- `settleWithSignature(...)` verifies backend EIP-712 settlement payloads
- `expireSession(bytes32 sessionId)` closes stale sessions as `CRASHED`
- Owner can `pause()` and `unpause()`
- `sessionExpiryDelay` is configurable
- Upgradeable through UUPS

## Prerequisites

- Foundry installed
- a Monad testnet RPC URL
- a deployer private key for broadcasts

## Environment

Set values in `sc/.env`:

```bash
MONAD_RPC_URL=https://your-monad-testnet-rpc
PRIVATE_KEY=0xyour_private_key
INITIAL_OWNER=0xyour_owner_address
USDC_FAUCET_CLAIM_AMOUNT=100000000
BACKEND_SIGNER=0xyour_backend_signer_address
SESSION_EXPIRY_DELAY=86400
```

Minimum required values for deployment are:

- `MONAD_RPC_URL`
- `PRIVATE_KEY`

Other useful values:

- `INITIAL_OWNER`
- `GAME_VAULT_ADDRESS`
- `GAME_SETTLEMENT_ADDRESS`
- `TRUST_PASSPORT_ADDRESS`
- `NEW_BACKEND_SIGNER`

## Commands

### Build

```bash
forge build
```

### Build for MonadVision / Sourcify

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

## Deploy to Monad Testnet

### Standard deploy

```bash
source .env
forge script script/DeployGameContracts.s.sol:DeployGameContracts --rpc-url "$MONAD_RPC_URL" --broadcast
```

### MonadVision / Sourcify-friendly deploy

```bash
source .env
FOUNDRY_PROFILE=monad_vision forge script script/DeployGameContracts.s.sol:DeployGameContracts --rpc-url "$MONAD_RPC_URL" --broadcast
```

The deploy script:

- deploys implementations for `GameUSDC`, `USDCFaucet`, `GameVault`, `GameSettlement`, and `TrustPassport`
- deploys UUPS proxies
- grants the faucet token minting rights
- sets `GameSettlement` as the authorized vault settlement operator
- prints the deployed addresses

Frontend-facing proxy outputs:

```bash
NEXT_PUBLIC_USDC_ADDRESS=<deployed_game_usdc>
NEXT_PUBLIC_GAME_VAULT_ADDRESS=<deployed_game_vault>
NEXT_PUBLIC_GAME_SETTLEMENT_ADDRESS=<deployed_game_settlement>
NEXT_PUBLIC_TRUST_PASSPORT_ADDRESS=<deployed_trust_passport>
```

## Verification

### Verify on MonadVision / Sourcify

```bash
FOUNDRY_PROFILE=monad_vision forge verify-contract \
  <contract_address> \
  <contract_name> \
  --chain 10143 \
  --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org/
```

### Verify on Monadscan / Socialscan

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

To update the backend signer after deployment:

```bash
source .env
forge script script/UpdateBackendSigner.s.sol:UpdateBackendSigner --rpc-url "$MONAD_RPC_URL" --broadcast
```

Use the owner key for the target contracts.

## Backend-Authoritative Flow

1. The user approves USDC and deposits into the vault.
2. The backend creates an `onchain_session_id`.
3. The frontend calls `GameSettlement.startSession(...)`.
4. The backend validates the game result offchain and signs a settlement payload.
5. The frontend or backend relayer submits settlement onchain.
6. Cashouts move value back into the user's available vault balance.
7. Crashes route stake into treasury.
