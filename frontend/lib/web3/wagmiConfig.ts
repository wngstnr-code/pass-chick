import type { Chain } from "viem";
import { MONAD_CHAIN } from "./monad";

const FALLBACK_CHAIN_ID = 10143;
const FALLBACK_RPC_URL = "https://testnet-rpc.monad.xyz";

function buildMonadWagmiChain(): Chain {
  const chainId = MONAD_CHAIN.chainIdDecimal > 0 ? MONAD_CHAIN.chainIdDecimal : FALLBACK_CHAIN_ID;
  const rpcUrl = MONAD_CHAIN.rpcUrls[0] || FALLBACK_RPC_URL;
  const explorerUrl = MONAD_CHAIN.blockExplorerUrls[0] || "";

  return {
    id: chainId,
    name: MONAD_CHAIN.chainName || "Monad",
    nativeCurrency: {
      name: MONAD_CHAIN.nativeCurrency.name,
      symbol: MONAD_CHAIN.nativeCurrency.symbol,
      decimals: MONAD_CHAIN.nativeCurrency.decimals,
    },
    rpcUrls: {
      default: { http: [rpcUrl] },
      public: { http: [rpcUrl] },
    },
    blockExplorers: explorerUrl
      ? {
          default: {
            name: "Monad Explorer",
            url: explorerUrl,
          },
        }
      : undefined,
    testnet: true,
  };
}

export const monadWagmiChain = buildMonadWagmiChain();

export const appKitNetworks: [Chain, ...Chain[]] = [monadWagmiChain];

export const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID || "demo-project-id";

export const appKitMetadata = {
  name: "Chicken Monad",
  description: "Crossy chicken game with mock betting HUD on Monad testnet.",
  url: "http://localhost:3000",
  icons: ["https://avatars.githubusercontent.com/u/37784886"],
};
