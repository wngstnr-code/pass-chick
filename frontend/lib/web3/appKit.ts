"use client";

import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import {
  appKitMetadata,
  appKitNetworks,
  monadWagmiChain,
  projectId,
} from "./wagmiConfig";

export const wagmiAdapter = new WagmiAdapter({
  networks: appKitNetworks,
  projectId,
  ssr: true,
});

type AppKitRuntimeWindow = typeof globalThis & {
  __CHICKEN_MONAD_APPKIT_INITIALIZED__?: boolean;
};

const appKitWindow = globalThis as AppKitRuntimeWindow;

function initializeAppKit() {
  if (appKitWindow.__CHICKEN_MONAD_APPKIT_INITIALIZED__) {
    return;
  }

  createAppKit({
    adapters: [wagmiAdapter],
    networks: appKitNetworks,
    defaultNetwork: monadWagmiChain,
    projectId,
    metadata: appKitMetadata,
  });
  appKitWindow.__CHICKEN_MONAD_APPKIT_INITIALIZED__ = true;
}

initializeAppKit();

export async function ensureAppKitInitialized() {
  initializeAppKit();
}
