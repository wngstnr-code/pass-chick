"use client";

import { useAppKit } from "@reown/appkit/react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { SiweMessage } from "siwe";
import {
  useAccount,
  useDisconnect,
  useSignMessage,
  useSwitchChain,
} from "wagmi";
import { backendFetch, backendPost } from "../../lib/backend/api";
import { BACKEND_API_URL, hasBackendApiConfig } from "../../lib/backend/config";
import { ensureAppKitInitialized } from "../../lib/web3/appKit";
import { MONAD_CHAIN, hasMonadChainConfig } from "../../lib/web3/monad";
import { readRawErrorMessage, toUserFacingWalletError } from "../../lib/errors";

type WalletContextValue = {
  account: string;
  chainIdHex: string;
  isMonadChain: boolean;
  isConnecting: boolean;
  error: string;
  connectWallet: () => Promise<void>;
  disconnectWallet: () => Promise<void>;
  switchToMonad: () => Promise<void>;
  clearWalletError: () => void;
  hasMonadChainConfig: boolean;
  monadChainIdHex: string;
  monadChainName: string;
  backendApiUrl: string;
  hasBackendApiConfig: boolean;
  isBackendAuthenticated: boolean;
  isBackendAuthLoading: boolean;
  backendAuthError: string;
  authenticateBackend: () => Promise<boolean>;
  ensureBackendSession: () => Promise<boolean>;
  logoutBackend: () => Promise<void>;
  refreshBackendSession: () => Promise<boolean>;
};

type WalletProviderProps = {
  children: ReactNode;
};

type AddChainArguments = {
  method: "wallet_addEthereumChain";
  params: Array<{
    chainId: string;
    chainName: string;
    nativeCurrency: {
      name: string;
      symbol: string;
      decimals: number;
    };
    rpcUrls: string[];
    blockExplorerUrls: string[];
  }>;
};

type Eip1193Provider = {
  request: (args: AddChainArguments) => Promise<unknown>;
};

type ChainSwitchError = {
  code?: number;
  message?: string;
};

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

function toHexChainId(chainId: number | undefined) {
  if (!chainId) return "";
  return `0x${chainId.toString(16)}`;
}

function readSwitchErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    return Number((error as ChainSwitchError).code);
  }
  return null;
}

function readErrorMessage(error: unknown, fallback: string) {
  return readRawErrorMessage(error, fallback);
}

function getEip1193Provider() {
  if (typeof window === "undefined") return null;
  const runtimeWindow = window as Window & { ethereum?: Eip1193Provider };
  return runtimeWindow.ethereum || null;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [error, setError] = useState("");
  const [isAppKitOpening, setIsAppKitOpening] = useState(false);
  const [backendAddress, setBackendAddress] = useState("");
  const [backendAuthLoading, setBackendAuthLoading] = useState(false);
  const [backendAuthError, setBackendAuthError] = useState("");
  const { open } = useAppKit();
  const { address, chainId, isConnected } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync, isPending: isSwitchPending } = useSwitchChain();

  const chainIdHex = toHexChainId(chainId);
  const account = address || "";
  const normalizedAccount = account.toLowerCase();
  const hasMonadConfig = hasMonadChainConfig();
  const hasBackendConfig = hasBackendApiConfig();
  const isMonadChain =
    hasMonadConfig &&
    chainIdHex.toLowerCase() === (MONAD_CHAIN.chainIdHex || "").toLowerCase();
  const isConnecting = isAppKitOpening || isSwitchPending;
  const isBackendAuthenticated =
    Boolean(backendAddress) &&
    Boolean(normalizedAccount) &&
    backendAddress.toLowerCase() === normalizedAccount;

  async function connectWallet() {
    setError("");
    setIsAppKitOpening(true);

    try {
      await ensureAppKitInitialized();
      await open();
    } catch (connectError) {
      setError(
        toUserFacingWalletError(connectError, "Gagal membuka modal wallet.", {
          userRejectedMessage: "Connect wallet dibatalkan.",
        }),
      );
    } finally {
      setIsAppKitOpening(false);
    }
  }

  async function disconnectWallet() {
    setError("");
    setBackendAddress("");
    setBackendAuthError("");

    try {
      await disconnectAsync();
    } catch {
      // Keep frontend state cleared even if the wallet adapter throws.
    }

    if (hasBackendConfig) {
      await logoutBackend();
    }
  }

  async function addMonadChainToWallet() {
    const provider = getEip1193Provider();
    if (!provider) {
      setError("Wallet EVM tidak terdeteksi.");
      return;
    }

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: MONAD_CHAIN.chainIdHex,
          chainName: MONAD_CHAIN.chainName,
          nativeCurrency: MONAD_CHAIN.nativeCurrency,
          rpcUrls: MONAD_CHAIN.rpcUrls,
          blockExplorerUrls: MONAD_CHAIN.blockExplorerUrls,
        },
      ],
    });
  }

  async function switchToMonad() {
    if (!isConnected) {
      setError("Connect wallet dulu sebelum switch chain.");
      return;
    }

    if (!hasMonadConfig) {
      setError(
        "Config Monad belum lengkap. Isi dulu variabel di frontend/.env.local.",
      );
      return;
    }

    setError("");

    try {
      await switchChainAsync({ chainId: MONAD_CHAIN.chainIdDecimal });
      return;
    } catch (switchError) {
      const switchCode = readSwitchErrorCode(switchError);
      const shouldTryAddChain =
        switchCode === 4902 ||
        readErrorMessage(switchError, "")
          .toLowerCase()
          .includes("unrecognized");

      if (!shouldTryAddChain) {
        setError(
          toUserFacingWalletError(switchError, "Gagal switch ke chain Monad.", {
            userRejectedMessage: "Switch chain dibatalkan di wallet.",
          }),
        );
        return;
      }
    }

    try {
      await addMonadChainToWallet();
      await switchChainAsync({ chainId: MONAD_CHAIN.chainIdDecimal });
    } catch (addChainError) {
      setError(
        toUserFacingWalletError(
          addChainError,
          "Gagal menambahkan chain Monad.",
          {
            userRejectedMessage: "Penambahan chain dibatalkan di wallet.",
          },
        ),
      );
    }
  }

  async function refreshBackendSession() {
    if (!hasBackendConfig) {
      setBackendAddress("");
      return false;
    }

    setBackendAuthLoading(true);
    try {
      const response = await backendFetch<{
        authenticated: boolean;
        address: string;
      }>("/auth/me");
      const sessionAddress = response.address?.toLowerCase?.() || "";
      if (
        !sessionAddress ||
        (normalizedAccount && sessionAddress !== normalizedAccount)
      ) {
        setBackendAddress("");
        return false;
      }

      setBackendAddress(sessionAddress);
      setBackendAuthError("");
      return true;
    } catch {
      setBackendAddress("");
      return false;
    } finally {
      setBackendAuthLoading(false);
    }
  }

  async function authenticateBackend() {
    if (!hasBackendConfig) {
      setBackendAuthError(
        "Config backend belum lengkap. Isi NEXT_PUBLIC_BACKEND_API_URL dulu.",
      );
      return false;
    }
    if (!isConnected || !account) {
      setBackendAuthError("Connect wallet dulu sebelum sign in ke backend.");
      return false;
    }

    setBackendAuthLoading(true);
    setBackendAuthError("");

    try {
      const { nonce } = await backendFetch<{ nonce: string }>("/auth/nonce");
      const domain = window.location.host;
      const origin = window.location.origin;
      const chainIdToUse = chainId || MONAD_CHAIN.chainIdDecimal || 10143;
      const statement = "Sign in to Chicken Monad backend.";
      const siweMessage = new SiweMessage({
        domain,
        address: account,
        statement,
        uri: origin,
        version: "1",
        chainId: chainIdToUse,
        nonce,
      });
      const message = siweMessage.prepareMessage();
      const signature = await signMessageAsync({ message });

      await backendPost<{ success: boolean; address: string }>("/auth/verify", {
        message,
        signature,
      });

      setBackendAddress(account.toLowerCase());
      setBackendAuthError("");
      return true;
    } catch (authError) {
      setBackendAddress("");
      setBackendAuthError(
        toUserFacingWalletError(authError, "Gagal auth ke backend.", {
          userRejectedMessage: "Sign in backend dibatalkan di wallet.",
        }),
      );
      return false;
    } finally {
      setBackendAuthLoading(false);
    }
  }

  async function ensureBackendSession() {
    if (!hasBackendConfig) {
      return false;
    }
    if (isBackendAuthenticated) {
      return true;
    }

    const hasExistingSession = await refreshBackendSession();
    if (hasExistingSession) {
      return true;
    }

    return authenticateBackend();
  }

  async function logoutBackend() {
    if (!hasBackendConfig) {
      setBackendAddress("");
      return;
    }

    try {
      await backendPost<{ success: boolean }>("/auth/logout");
    } catch {
      // Ignore logout failures on local dev; frontend state is still cleared.
    } finally {
      setBackendAddress("");
      setBackendAuthError("");
      setBackendAuthLoading(false);
    }
  }

  useEffect(() => {
    if (!isConnected) {
      setError("");
      setBackendAddress("");
      setBackendAuthError("");
    }
  }, [isConnected]);

  useEffect(() => {
    if (!hasBackendConfig || !isConnected || !account) {
      setBackendAddress("");
      return;
    }

    void refreshBackendSession();
  }, [account, hasBackendConfig, isConnected]);

  const value = useMemo<WalletContextValue>(
    () => ({
      account,
      chainIdHex,
      isMonadChain,
      isConnecting,
      error,
      connectWallet,
      disconnectWallet,
      switchToMonad,
      clearWalletError: () => setError(""),
      hasMonadChainConfig: hasMonadConfig,
      monadChainIdHex: MONAD_CHAIN.chainIdHex,
      monadChainName: MONAD_CHAIN.chainName,
      backendApiUrl: BACKEND_API_URL,
      hasBackendApiConfig: hasBackendConfig,
      isBackendAuthenticated,
      isBackendAuthLoading: backendAuthLoading,
      backendAuthError,
      authenticateBackend,
      ensureBackendSession,
      logoutBackend,
      refreshBackendSession,
    }),
    [
      account,
      backendAuthError,
      backendAuthLoading,
      chainIdHex,
      error,
      hasBackendConfig,
      hasMonadConfig,
      isBackendAuthenticated,
      isConnecting,
      isMonadChain,
    ],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWallet() {
  const value = useContext(WalletContext);
  if (!value) {
    throw new Error("useWallet harus dipakai di dalam WalletProvider.");
  }
  return value;
}
