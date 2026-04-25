"use client";

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { formatUnits, isAddress, parseUnits } from "viem";
import type { Address, Hash, Hex } from "viem";
import {
  readContract,
  waitForTransactionReceipt,
  writeContract,
} from "@wagmi/core";
import { useConfig } from "wagmi";
import { useWallet } from "../web3/WalletProvider";
import { backendPost, backendFetch } from "../../lib/backend/api";
import { BACKEND_API_URL, hasBackendApiConfig } from "../../lib/backend/config";
import {
  isUserRejectedWalletError,
  readRawErrorMessage,
  toUserFacingWalletError,
} from "../../lib/errors";
import {
  ERC20_ABI,
  GAME_SETTLEMENT_ABI,
  GAME_SETTLEMENT_ADDRESS,
  GAME_VAULT_ABI,
  GAME_VAULT_ADDRESS,
  TRUST_PASSPORT_ABI,
  TRUST_PASSPORT_ADDRESS,
  USDC_ADDRESS,
  USDC_DECIMALS,
  USDC_FAUCET_ABI,
  USDC_FAUCET_ADDRESS,
  hasGameContractConfig,
  hasPassportContractConfig,
} from "../../lib/web3/contracts";

type GameBridgeClientProps = {
  backgroundMode?: boolean;
};

type StartedPayload = {
  sessionId: string;
  onchainSessionId: string;
  stake: number;
  stakeAmountUnits: string;
};

type SettlementPayload = {
  sessionId: string;
  onchainSessionId: string;
  settlementTxHash?: string;
  settlementSignature?: string;
  signature?: string;
  resolution?: ChickenBridgeSettlementResolution;
  payload?: ChickenBridgeSettlementResolution;
  multiplier?: string;
  payoutAmount?: string;
  profit?: string;
  reason?: string;
};

type ReconnectedPayload = {
  sessionId: string;
  onchainSessionId: string;
  stake: number;
  stakeAmountUnits: string;
  row: number;
  maxRow: number;
  multiplierBp: number;
  multiplier: string;
  cp: number;
  cashoutWindow: boolean;
  segmentRemainingMs: number;
  cpStayRemainingMs: number;
  decayBp: number;
  serverTime: number;
};

type ActiveBackendSessionPayload = {
  hasActiveGame: boolean;
  session?: {
    session_id?: string;
    onchain_session_id?: string;
    stake_amount?: number | string;
    created_at?: string;
  } | null;
};

type PassportIssueSignaturePayload = {
  success: boolean;
  claim: {
    player: string;
    tier: number;
    issuedAt: string;
    expiry: string;
    nonce: string;
  };
  signature: string;
  signatureExpiry: number;
  eligibility: ChickenBridgePassportEligibility;
};

type PendingResolver<T> = {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  timeoutId: number;
};

const RESPONSE_TIMEOUT_MS = 45_000;
const RECONNECT_GRACE_TIMEOUT_MS = 32_000;
const APPROVE_MAX_USDC_UNITS = parseUnits("10000000", USDC_DECIMALS);
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const ACTIVE_SESSION_CACHE_MS = 1200;

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function normalizeError(error: unknown, fallback: string) {
  return readRawErrorMessage(error, fallback);
}

function isUserRejectedRequestError(error: unknown) {
  return isUserRejectedWalletError(error);
}

function shouldAbortStartSessionOnReceiptError(error: unknown) {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: string }).name || "").toLowerCase()
      : "";
  const message = normalizeError(error, "").toLowerCase();
  const combined = `${name} ${message}`;

  const uncertainPatterns = [
    "timeout",
    "timed out",
    "not found",
    "pending",
    "network",
    "fetch",
    "socket",
    "disconnect",
    "rate limit",
    "429",
    "rpc",
    "temporary",
  ];

  return !uncertainPatterns.some((pattern) => combined.includes(pattern));
}

function toStartSessionFailureMessage(error: unknown, fallback: string) {
  const normalized = normalizeError(error, fallback).toLowerCase();

  if (normalized.includes("insufficientavailablebalance")) {
    return "Saldo available di vault tidak cukup untuk nominal bet ini. Deposit dulu atau kecilkan stake.";
  }
  if (normalized.includes("sessionalreadyactive")) {
    return "Masih ada session aktif on-chain. Selesaikan settlement run sebelumnya dulu lalu coba lagi.";
  }
  if (normalized.includes("invalidstakeamount")) {
    return "Nominal stake tidak valid untuk kontrak settlement.";
  }
  if (normalized.includes("invalidsessionid")) {
    return "Session ID on-chain tidak valid. Coba start bet ulang.";
  }
  if (normalized.includes("enforcedpause") || normalized.includes("paused")) {
    return "Contract settlement sedang pause. Coba lagi beberapa saat.";
  }

  return toUserFacingWalletError(error, fallback, {
    userRejectedMessage: "Start bet dibatalkan di wallet.",
  });
}

function toNumberAmount(value: bigint) {
  return Number(formatUnits(value, USDC_DECIMALS));
}

function rejectPendingRequest<T>(
  pending: PendingResolver<T> | null,
  message: string,
) {
  if (!pending) return;
  window.clearTimeout(pending.timeoutId);
  pending.reject(new Error(message));
}

export function GameBridgeClient({
  backgroundMode = false,
}: GameBridgeClientProps) {
  const wagmiConfig = useConfig();
  const {
    account,
    isMonadChain,
    isBackendAuthenticated,
    hasBackendApiConfig: hasBackendConfig,
    ensureBackendSession,
    refreshBackendSession,
  } = useWallet();
  const socketRef = useRef<Socket | null>(null);
  const activeSessionIdRef = useRef<string>("");
  const pendingStartRef = useRef<PendingResolver<StartedPayload> | null>(null);
  const pendingCashoutRef = useRef<PendingResolver<SettlementPayload> | null>(
    null,
  );
  const pendingCrashRef = useRef<PendingResolver<SettlementPayload> | null>(
    null,
  );
  const reconnectTimeoutRef = useRef<number | null>(null);
  const activeSessionCacheRef = useRef<{
    address: Address | null;
    value: string;
    fetchedAt: number;
  }>({
    address: null,
    value: ZERO_BYTES32,
    fetchedAt: 0,
  });

  useEffect(() => {
    if (backgroundMode) return;

    document.documentElement.classList.add("play-scroll-lock");
    document.body.classList.add("play-scroll-lock");

    return () => {
      document.documentElement.classList.remove("play-scroll-lock");
      document.body.classList.remove("play-scroll-lock");
    };
  }, [backgroundMode]);

  useEffect(() => {
    if (backgroundMode) {
      window.__CHICKEN_MONAD_BRIDGE__ = {
        backgroundMode: true,
        loadAvailableBalance: async () => 0,
        loadDepositBalances: async () => ({
          walletBalance: 0,
          availableBalance: 0,
          lockedBalance: 0,
          allowance: 0,
        }),
        loadLeaderboard: async () => ({
          leaderboard: [],
          walletAddress: "",
        }),
        loadPlayerStats: async () => ({
          wallet_address: "",
          total_games: 0,
          total_wins: 0,
          total_losses: 0,
          total_profit: 0,
          created_at: null,
        }),
        loadGameHistory: async (limit = 3) => ({
          sessions: [],
          total: 0,
          limit,
          offset: 0,
        }),
        loadPlayerTransactions: async (limit = 3) => ({
          transactions: [],
          total: 0,
          limit,
          offset: 0,
        }),
        getWalletAddress: () => "",
        openDeposit: (presetAmount?: number) => {
          window.dispatchEvent(
            new CustomEvent("chicken:open-deposit-modal", {
              detail: { amount: presetAmount },
            }),
          );
        },
        claimFaucet: async () => {
          throw new Error("Background mode tidak mendukung faucet claim.");
        },
        depositToVault: async () => {
          throw new Error("Background mode tidak mendukung deposit.");
        },
        startBet: async () => {
          throw new Error("Background mode tidak mendukung start bet.");
        },
        sendMove: () => {},
        cashOut: async () => {
          throw new Error("Background mode tidak mendukung cash out.");
        },
        crash: async () => null,
        autoSettlePending: async () => false,
        getPlayBlocker: async () => ({ kind: "none" }),
        resolvePlayBlocker: async () => false,
        getPassportStatus: async () => ({
          walletAddress: "",
          eligibility: {
            eligible: false,
            tier: 0,
            reason: "Background mode.",
            stats: {
              runsEvaluated: 0,
              bestHops: 0,
              averageHops: 0,
            },
          },
          passport: {
            configured: false,
            valid: false,
            tier: 0,
            issuedAt: 0,
            expiry: 0,
            revoked: false,
          },
        }),
        claimPassport: async () => {
          throw new Error("Background mode tidak mendukung claim passport.");
        },
      };

      return () => {
        delete window.__CHICKEN_MONAD_BRIDGE__;
      };
    }

    function ensureSocket() {
      if (socketRef.current) {
        return socketRef.current;
      }

      if (!hasBackendApiConfig() || !BACKEND_API_URL) {
        throw new Error("NEXT_PUBLIC_BACKEND_API_URL belum diisi.");
      }

      const socket = io(BACKEND_API_URL, {
        withCredentials: true,
        transports: ["websocket", "polling"],
      });

      socket.on("game:started", (payload: StartedPayload) => {
        const pending = pendingStartRef.current;
        if (!pending) return;

        pendingStartRef.current = null;
        window.clearTimeout(pending.timeoutId);
        emitPlayBlocker({ kind: "none" });
        pending.resolve(payload);
      });

      socket.on("game:reconnected", (payload: ReconnectedPayload) => {
        const expectedSessionId = activeSessionIdRef.current;
        if (expectedSessionId && payload.sessionId !== expectedSessionId) {
          return;
        }

        if (reconnectTimeoutRef.current) {
          window.clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }

        // After a browser refresh we may not have local sessionId anymore,
        // but backend can still restore the paused run for this wallet.
        activeSessionIdRef.current = payload.sessionId;
        emitPlayBlocker({ kind: "none" });
        window.dispatchEvent(
          new CustomEvent("chicken:game-reconnected", {
            detail: payload,
          }),
        );
      });

      socket.on("game:cashout_result", (payload: SettlementPayload) => {
        const pending = pendingCashoutRef.current;
        if (!pending) return;

        pendingCashoutRef.current = null;
        window.clearTimeout(pending.timeoutId);
        pending.resolve(payload);
      });

      socket.on("game:crashed", (payload: SettlementPayload) => {
        const pending = pendingCrashRef.current;
        if (!pending) return;

        pendingCrashRef.current = null;
        window.clearTimeout(pending.timeoutId);
        pending.resolve(payload);
      });

      socket.on("game:start_aborted", (payload: { message?: string }) => {
        activeSessionIdRef.current = "";
        const message =
          payload?.message ||
          "Transaksi startSession gagal/revert. Silakan start bet ulang.";
        void refreshPlayBlockerStatus();
        window.dispatchEvent(
          new CustomEvent("chicken:start-bet-failed", {
            detail: { message },
          }),
        );
      });

      socket.on("game:error", (payload: { message?: string }) => {
        const message = toUserFacingWalletError(
          payload?.message || "",
          "Backend game error.",
        );
        rejectPendingRequest(pendingStartRef.current, message);
        rejectPendingRequest(pendingCashoutRef.current, message);
        rejectPendingRequest(pendingCrashRef.current, message);
        pendingStartRef.current = null;
        pendingCashoutRef.current = null;
        pendingCrashRef.current = null;
        window.dispatchEvent(
          new CustomEvent("chicken:game-error", { detail: { message } }),
        );
      });

      socket.on("error", (payload: { message?: string } | string) => {
        const message = toUserFacingWalletError(
          typeof payload === "string" ? payload : payload?.message || "",
          "Socket error dari backend.",
        );

        rejectPendingRequest(pendingStartRef.current, message);
        rejectPendingRequest(pendingCashoutRef.current, message);
        rejectPendingRequest(pendingCrashRef.current, message);
        pendingStartRef.current = null;
        pendingCashoutRef.current = null;
        pendingCrashRef.current = null;
        window.dispatchEvent(
          new CustomEvent("chicken:game-error", { detail: { message } }),
        );
      });

      socket.on("disconnect", (reason) => {
        if (reconnectTimeoutRef.current) {
          window.clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }

        const message =
          reason === "io server disconnect"
            ? "Socket diputus server. Sign in backend lagi lalu coba start bet."
            : `Socket disconnected: ${reason}`;

        rejectPendingRequest(pendingStartRef.current, message);
        rejectPendingRequest(pendingCashoutRef.current, message);
        rejectPendingRequest(pendingCrashRef.current, message);
        pendingStartRef.current = null;
        pendingCashoutRef.current = null;
        pendingCrashRef.current = null;

        if (!activeSessionIdRef.current) {
          return;
        }

        if (reason === "io server disconnect") {
          const expiredMessage =
            "Run pause gagal dipulihkan karena socket diputus server. Sign in backend lagi lalu start ulang.";
          activeSessionIdRef.current = "";
          window.dispatchEvent(
            new CustomEvent("chicken:game-reconnect-expired", {
              detail: { message: expiredMessage },
            }),
          );
          return;
        }

        window.dispatchEvent(
          new CustomEvent("chicken:game-disconnected", {
            detail: { message },
          }),
        );

        reconnectTimeoutRef.current = window.setTimeout(() => {
          reconnectTimeoutRef.current = null;
          if (!activeSessionIdRef.current) return;

          activeSessionIdRef.current = "";
          window.dispatchEvent(
            new CustomEvent("chicken:game-reconnect-expired", {
              detail: {
                message:
                  "Koneksi ke server terlalu lama putus. Run dianggap berakhir dan akan disinkronkan saat kamu mulai lagi.",
              },
            }),
          );
        }, RECONNECT_GRACE_TIMEOUT_MS);
      });

      socket.on("game:cp_expired", (payload: { message?: string }) => {
        window.dispatchEvent(
          new CustomEvent("chicken:cp-expired", {
            detail: { message: payload?.message || "" },
          }),
        );
      });

      socketRef.current = socket;
      return socket;
    }

    async function waitForSocketReady(socket: Socket) {
      if (socket.connected) return;

      await new Promise<void>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          socket.off("connect", onConnect);
          socket.off("connect_error", onError);
          reject(new Error("Socket connection timeout."));
        }, RESPONSE_TIMEOUT_MS);

        function onConnect() {
          window.clearTimeout(timeoutId);
          socket.off("connect_error", onError);
          resolve();
        }

        function onError(error: Error) {
          window.clearTimeout(timeoutId);
          socket.off("connect", onConnect);
          reject(error);
        }

        socket.once("connect", onConnect);
        socket.once("connect_error", onError);
      });
    }

    function createPendingRequest<T>(
      ref: React.MutableRefObject<PendingResolver<T> | null>,
    ) {
      return new Promise<T>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          ref.current = null;
          reject(new Error("Backend response timeout."));
        }, RESPONSE_TIMEOUT_MS);

        ref.current = { resolve, reject, timeoutId };
      });
    }

    function emitDepositProgress(phase: string, message?: string) {
      window.dispatchEvent(
        new CustomEvent("chicken:deposit-progress", {
          detail: { phase, message: message || "" },
        }),
      );
    }

    async function requireOnchainWallet() {
      if (!account || !isAddress(account)) {
        throw new Error("Connect wallet dulu sebelum main.");
      }
      if (!isMonadChain) {
        throw new Error("Switch wallet ke Monad dulu sebelum main.");
      }
      if (!hasGameContractConfig()) {
        throw new Error("Config contract frontend belum lengkap.");
      }
      return account as Address;
    }

    function isRateLimitedRpcError(error: unknown) {
      const message = normalizeError(error, "").toLowerCase();
      return (
        message.includes("requests limited to 15/sec") ||
        message.includes("rate limit") ||
        message.includes("429") ||
        message.includes("too many requests")
      );
    }

    async function readContractWithRetry<T>(
      reader: () => Promise<T>,
      retries = 3,
    ): Promise<T> {
      let attempt = 0;
      while (true) {
        try {
          return await reader();
        } catch (error) {
          if (!isRateLimitedRpcError(error) || attempt >= retries) {
            throw error;
          }
          const backoffMs = 250 * Math.pow(2, attempt);
          attempt += 1;
          await sleep(backoffMs);
        }
      }
    }

    async function requireReadyGameWallet() {
      const playerAddress = await requireOnchainWallet();
      if (!hasBackendConfig) {
        throw new Error("Config backend frontend belum lengkap.");
      }

      const authOkay = await ensureBackendSession();
      if (!authOkay) {
        throw new Error(
          "Backend session belum aktif. Sign in ke backend dulu.",
        );
      }

      return playerAddress;
    }

    async function requireBackendWalletSession() {
      if (!account || !isAddress(account)) {
        throw new Error("Connect wallet dulu untuk melihat player stats.");
      }
      if (!hasBackendConfig) {
        throw new Error("Config backend frontend belum lengkap.");
      }

      const authOkay = await ensureBackendSession();
      if (!authOkay) {
        throw new Error(
          "Backend session belum aktif. Connect wallet lalu sign in dulu.",
        );
      }

      return account as Address;
    }

    function normalizeHistoryLimit(limit: number | undefined, fallback = 3) {
      const parsed = Number(limit);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.max(1, Math.min(Math.floor(parsed), 20));
    }

    async function readAvailableBalance(address: Address) {
      const value = await readContractWithRetry(() =>
        readContract(wagmiConfig, {
          address: GAME_VAULT_ADDRESS as Address,
          abi: GAME_VAULT_ABI,
          functionName: "availableBalanceOf",
          args: [address],
        }),
      );

      return toNumberAmount(value);
    }

    async function readLockedBalance(address: Address) {
      const value = await readContractWithRetry(() =>
        readContract(wagmiConfig, {
          address: GAME_VAULT_ADDRESS as Address,
          abi: GAME_VAULT_ABI,
          functionName: "lockedBalanceOf",
          args: [address],
        }),
      );

      return toNumberAmount(value);
    }

    async function readActiveSessionId(address: Address) {
      const cached = activeSessionCacheRef.current;
      const now = Date.now();
      if (
        cached.address &&
        cached.address.toLowerCase() === address.toLowerCase() &&
        now - cached.fetchedAt < ACTIVE_SESSION_CACHE_MS
      ) {
        return cached.value;
      }

      const value = await readContractWithRetry(() =>
        readContract(wagmiConfig, {
          address: GAME_SETTLEMENT_ADDRESS as Address,
          abi: GAME_SETTLEMENT_ABI,
          functionName: "activeSessionOf",
          args: [address],
        }),
      );

      const normalized = String(value || "");
      activeSessionCacheRef.current = {
        address,
        value: normalized,
        fetchedAt: now,
      };

      return normalized;
    }

    function invalidateActiveSessionCache() {
      activeSessionCacheRef.current = {
        address: null,
        value: ZERO_BYTES32,
        fetchedAt: 0,
      };
    }

    function isZeroSessionId(value: string) {
      return !value || value.toLowerCase() === ZERO_BYTES32;
    }

    function shortSessionId(value?: string | null) {
      const normalized = String(value || "");
      if (!normalized) return "";
      return `${normalized.slice(0, 10)}...`;
    }

    function emitPlayBlocker(blocker: ChickenBridgePlayBlocker) {
      window.dispatchEvent(
        new CustomEvent("chicken:play-blocker", {
          detail: blocker,
        }),
      );
    }

    async function readWalletUsdcBalance(address: Address) {
      const value = await readContractWithRetry(() =>
        readContract(wagmiConfig, {
          address: USDC_ADDRESS as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        }),
      );

      return toNumberAmount(value);
    }

    async function readUsdcAllowance(owner: Address) {
      const value = await readContractWithRetry(() =>
        readContract(wagmiConfig, {
          address: USDC_ADDRESS as Address,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [owner, GAME_VAULT_ADDRESS as Address],
        }),
      );

      return value;
    }

    async function writeAndConfirm(
      request: Parameters<typeof writeContract>[1],
    ) {
      const txHash = await writeContract(wagmiConfig, request);
      await waitForTransactionReceipt(wagmiConfig, { hash: txHash as Hash });
      invalidateActiveSessionCache();
      return txHash as string;
    }

    async function fetchActiveBackendSession() {
      try {
        return await backendFetch<ActiveBackendSessionPayload>("/api/game/active");
      } catch (err) {
        console.error("❌ Gagal fetch active session:", err);
        return {
          hasActiveGame: false,
          session: null,
        };
      }
    }

    async function fetchPendingSettlements() {
      try {
        return await backendFetch<{
          hasPending: boolean;
          pendingSettlements: any[];
        }>("/api/game/pending-settlement");
      } catch (err) {
        console.error("❌ Gagal fetch pending settlement:", err);
        return {
          hasPending: false,
          pendingSettlements: [],
        };
      }
    }

    async function getPlayBlocker(): Promise<ChickenBridgePlayBlocker> {
      if (
        !account ||
        !isAddress(account) ||
        !isMonadChain ||
        !hasGameContractConfig() ||
        !hasBackendConfig
      ) {
        return { kind: "none" };
      }

      const authOkay =
        isBackendAuthenticated || (await refreshBackendSession());
      if (!authOkay) {
        return { kind: "none" };
      }

      const playerAddress = account as Address;
      const [pending, activeBackendSession, activeSessionId] =
        await Promise.all([
          fetchPendingSettlements(),
          fetchActiveBackendSession(),
          readActiveSessionId(playerAddress),
        ]);

      if (pending.hasPending && pending.pendingSettlements.length > 0) {
        const pendingCount = pending.pendingSettlements.length;
        const firstPending = pending.pendingSettlements[0];
        return {
          kind: "pending_settlement",
          message:
            pendingCount > 1
              ? `${pendingCount} PREV BETS NEED SETTLEMENT`
              : "PREV BET NEEDS SETTLEMENT",
          actionLabel: "END NOW",
          onchainSessionId: String(
            firstPending?.onchain_session_id ||
              firstPending?.resolution?.sessionId ||
              "",
          ),
          pendingCount,
        };
      }

      if (!isZeroSessionId(activeSessionId)) {
        return {
          kind: "active_previous",
          message: "PREV BET STILL NOT END",
          actionLabel: "END NOW",
          onchainSessionId: activeSessionId,
        };
      }

      if (activeBackendSession.hasActiveGame) {
        return {
          kind: "active_previous",
          message: "PREV BET STILL NOT END",
          actionLabel: "END NOW",
          onchainSessionId: String(
            activeBackendSession.session?.onchain_session_id || "",
          ),
        };
      }

      return { kind: "none" };
    }

    async function refreshPlayBlockerStatus() {
      const blocker = await getPlayBlocker();
      emitPlayBlocker(blocker);
      return blocker;
    }

    async function settlePendingSettlements(
      pendingSettlements: any[],
      options?: { targetOnchainSessionId?: string },
    ) {
      const targetOnchainSessionId =
        options?.targetOnchainSessionId?.toLowerCase() || "";
      const candidates = targetOnchainSessionId
        ? pendingSettlements.filter((session) => {
            const onchainSessionId = String(
              session.onchain_session_id ||
                session.resolution?.sessionId ||
                session.payload?.sessionId ||
                "",
            ).toLowerCase();
            return onchainSessionId === targetOnchainSessionId;
          })
        : pendingSettlements;

      if (candidates.length === 0) {
        return false;
      }

      let settledCount = 0;
      let failedCount = 0;
      let firstFailureMessage = "";

      for (const s of candidates) {
        try {
          emitDepositProgress(
            "settle_pending",
            `Settling old session ${String(s.onchain_session_id || "").slice(0, 10)}...`,
          );

          await backendPost<{
            success: boolean;
            txHash?: string;
          }>("/api/game/submit-settlement", {
            sessionId: s.session_id,
          });
          console.log(`✅ Old session ${s.session_id} settled by backend.`);
          settledCount += 1;
        } catch (err) {
          console.error(`❌ Gagal settle old session ${s.session_id}:`, err);
          if (!firstFailureMessage) {
            firstFailureMessage = normalizeError(
              err,
              "Settlement pending gagal diproses.",
            );
          }
          failedCount += 1;
        }
      }

      if (failedCount > 0) {
        emitDepositProgress(
          "settle_incomplete",
          firstFailureMessage ||
            `${failedCount} pending settlement belum berhasil disettle.`,
        );
        throw new Error(
          firstFailureMessage ||
            `${failedCount} pending settlement belum berhasil disettle. Coba lagi sebelum start bet.`,
        );
      }

      if (settledCount > 0) {
        emitDepositProgress("done", "Old session settled.");
      }

      return settledCount > 0;
    }

    window.__CHICKEN_MONAD_BRIDGE__ = {
      backgroundMode: false,
      loadAvailableBalance: async () => {
        if (!account || !isAddress(account) || !hasGameContractConfig()) {
          return 0;
        }

        await refreshBackendSession();
        return readAvailableBalance(account as Address);
      },
      loadDepositBalances: async () => {
        if (!account || !isAddress(account) || !hasGameContractConfig()) {
          return {
            walletBalance: 0,
            availableBalance: 0,
            lockedBalance: 0,
            allowance: 0,
          };
        }

        const address = account as Address;
        await refreshBackendSession();

        const [
          walletBalance,
          availableBalance,
          lockedBalance,
          allowanceUnits,
        ] = await Promise.all([
          readWalletUsdcBalance(address),
          readAvailableBalance(address),
          readLockedBalance(address),
          readUsdcAllowance(address),
        ]);

        return {
          walletBalance,
          availableBalance,
          lockedBalance,
          allowance: toNumberAmount(allowanceUnits),
        };
      },
      loadLeaderboard: async () => {
        if (!hasBackendConfig) {
          throw new Error("Config backend frontend belum lengkap.");
        }

        const payload = await backendFetch<{
          leaderboard?: ChickenBridgeLeaderboardEntry[];
        }>("/api/leaderboard");

        return {
          leaderboard: Array.isArray(payload?.leaderboard)
            ? payload.leaderboard
            : [],
          walletAddress: account && isAddress(account) ? account : "",
        };
      },
      loadPlayerStats: async () => {
        await requireBackendWalletSession();
        return backendFetch<ChickenBridgePlayerStats>("/api/player/stats");
      },
      loadGameHistory: async (limit = 3) => {
        await requireBackendWalletSession();

        const safeLimit = normalizeHistoryLimit(limit);
        const payload = await backendFetch<ChickenBridgeGameHistoryPayload>(
          `/api/game/history?limit=${safeLimit}&offset=0`,
        );

        return {
          sessions: Array.isArray(payload?.sessions) ? payload.sessions : [],
          total: Number(payload?.total || 0),
          limit: Number(payload?.limit || safeLimit),
          offset: Number(payload?.offset || 0),
        };
      },
      loadPlayerTransactions: async (limit = 3) => {
        await requireBackendWalletSession();

        const safeLimit = normalizeHistoryLimit(limit);
        const payload = await backendFetch<ChickenBridgePlayerTransactionsPayload>(
          `/api/player/transactions?limit=${safeLimit}&offset=0`,
        );

        return {
          transactions: Array.isArray(payload?.transactions)
            ? payload.transactions
            : [],
          total: Number(payload?.total || 0),
          limit: Number(payload?.limit || safeLimit),
          offset: Number(payload?.offset || 0),
        };
      },
      getWalletAddress: () =>
        account && isAddress(account) ? account : "",
      openDeposit: (presetAmount?: number) => {
        window.dispatchEvent(
          new CustomEvent("chicken:open-deposit-modal", {
            detail: { amount: presetAmount },
          }),
        );
      },
      claimFaucet: async () => {
        const playerAddress = await requireOnchainWallet();
        if (!isAddress(USDC_FAUCET_ADDRESS)) {
          throw new Error("Config faucet contract belum valid.");
        }

        let txHash: string;
        try {
          txHash = await writeAndConfirm({
            address: USDC_FAUCET_ADDRESS as Address,
            abi: USDC_FAUCET_ABI,
            functionName: "claim",
          });
        } catch (error) {
          throw new Error(
            toUserFacingWalletError(error, "Claim faucet gagal.", {
              userRejectedMessage: "Claim faucet dibatalkan di wallet.",
            }),
          );
        }

        return {
          txHash,
          walletBalance: await readWalletUsdcBalance(playerAddress),
        };
      },
      depositToVault: async (amountInput: number | string) => {
        const playerAddress = await requireOnchainWallet();

        if (!isAddress(USDC_ADDRESS) || !isAddress(GAME_VAULT_ADDRESS)) {
          throw new Error("Config USDC/Vault contract belum valid.");
        }

        const normalizedAmount = String(amountInput || "").trim();
        let amountUnits: bigint;
        try {
          amountUnits = parseUnits(normalizedAmount, USDC_DECIMALS);
        } catch {
          throw new Error("Amount deposit tidak valid.");
        }

        if (amountUnits <= 0n) {
          throw new Error("Amount deposit harus lebih dari 0.");
        }

        emitDepositProgress(
          "checking",
          "Checking wallet balance and allowance...",
        );

        const walletBalanceUnits = await readContract(wagmiConfig, {
          address: USDC_ADDRESS as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [playerAddress],
        });

        if (walletBalanceUnits < amountUnits) {
          throw new Error("Saldo wallet USDC kurang. Claim faucet dulu.");
        }

        let approveTxHash: string | undefined;
        const allowance = await readUsdcAllowance(playerAddress);
        if (allowance < amountUnits) {
          emitDepositProgress(
            "approve_sign",
            "Sign 1/2: approve max USDC for vault.",
          );
          try {
            approveTxHash = (await writeContract(wagmiConfig, {
              address: USDC_ADDRESS as Address,
              abi: ERC20_ABI,
              functionName: "approve",
              args: [GAME_VAULT_ADDRESS as Address, APPROVE_MAX_USDC_UNITS],
            })) as string;
          } catch (error) {
            throw new Error(
              toUserFacingWalletError(error, "Approve USDC gagal.", {
                userRejectedMessage: "Approve USDC dibatalkan di wallet.",
              }),
            );
          }
          emitDepositProgress(
            "approve_pending",
            "Approve tx submitted. Waiting confirmation...",
          );
          try {
            await waitForTransactionReceipt(wagmiConfig, {
              hash: approveTxHash as Hash,
            });
          } catch (error) {
            throw new Error(
              toUserFacingWalletError(error, "Approve USDC belum terkonfirmasi.", {
                networkMessage:
                  "Konfirmasi approve belum terbaca. Cek wallet atau explorer lalu coba lagi.",
              }),
            );
          }
        }

        emitDepositProgress("deposit_sign", "Sign 2/2: deposit USDC to vault.");
        let depositTxHash: string;
        try {
          depositTxHash = (await writeContract(wagmiConfig, {
            address: GAME_VAULT_ADDRESS as Address,
            abi: GAME_VAULT_ABI,
            functionName: "deposit",
            args: [amountUnits],
          })) as string;
        } catch (error) {
          throw new Error(
            toUserFacingWalletError(error, "Deposit gagal.", {
              userRejectedMessage: "Deposit dibatalkan di wallet.",
            }),
          );
        }
        emitDepositProgress(
          "deposit_pending",
          "Deposit tx submitted. Waiting confirmation...",
        );
        try {
          await waitForTransactionReceipt(wagmiConfig, {
            hash: depositTxHash as Hash,
          });
        } catch (error) {
          throw new Error(
            toUserFacingWalletError(error, "Deposit belum terkonfirmasi.", {
              networkMessage:
                "Konfirmasi deposit belum terbaca. Cek wallet atau explorer lalu coba lagi.",
            }),
          );
        }
        emitDepositProgress("done", "Deposit confirmed.");

        return {
          approveTxHash,
          depositTxHash,
          availableBalance: await readAvailableBalance(playerAddress),
        };
      },
      autoSettlePending: async () => {
        await requireReadyGameWallet();

        // 1. Cek apakah ada settlement yang tertunda di backend (sudah sign tapi belum submit ke chain)
        const pending = await fetchPendingSettlements();

        if (!pending.hasPending || pending.pendingSettlements.length === 0) {
          await refreshPlayBlockerStatus();
          return false;
        }

        console.log(
          `🧹 Auto-settling ${pending.pendingSettlements.length} pending session(s)...`,
        );

        const didSettle = await settlePendingSettlements(
          pending.pendingSettlements,
        );
        await refreshPlayBlockerStatus();
        return didSettle;
      },
      getPlayBlocker: async () => {
        const blocker = await getPlayBlocker();
        emitPlayBlocker(blocker);
        return blocker;
      },
      resolvePlayBlocker: async () => {
        const playerAddress = await requireReadyGameWallet();
        const blocker = await getPlayBlocker();

        if (blocker.kind === "none") {
          emitPlayBlocker(blocker);
          return false;
        }

        if (blocker.kind === "pending_settlement") {
          const pending = await fetchPendingSettlements();
          if (pending.hasPending && pending.pendingSettlements.length > 0) {
            await settlePendingSettlements(pending.pendingSettlements, {
              targetOnchainSessionId: blocker.onchainSessionId,
            });
          }
        } else {
          emitDepositProgress("settle_sign", "Ending previous bet...");
          await backendPost<{
            success: boolean;
            resolved?: boolean;
          }>("/api/game/force-end-active");

          const pending = await fetchPendingSettlements();
          if (pending.hasPending && pending.pendingSettlements.length > 0) {
            await settlePendingSettlements(pending.pendingSettlements, {
              targetOnchainSessionId: blocker.onchainSessionId,
            });
          }

          const refreshedActiveSessionId = await readActiveSessionId(
            playerAddress,
          );
          if (!isZeroSessionId(refreshedActiveSessionId)) {
            throw new Error(
              `Masih ada session onchain lama yang aktif (${shortSessionId(refreshedActiveSessionId)}). Coba lagi sebentar.`,
            );
          }
        }

        const refreshedBlocker = await refreshPlayBlockerStatus();
        return refreshedBlocker.kind === "none";
      },
      getPassportStatus: async () => {
        await requireBackendWalletSession();
        return backendFetch<ChickenBridgePassportStatus>("/api/passport/status");
      },
      claimPassport: async () => {
        const playerAddress = await requireReadyGameWallet();
        if (!hasPassportContractConfig() || !isAddress(TRUST_PASSPORT_ADDRESS)) {
          throw new Error("Config TRUST_PASSPORT_ADDRESS belum valid.");
        }

        const status = await backendFetch<ChickenBridgePassportStatus>(
          "/api/passport/status",
        );
        if (!status.eligibility?.eligible || status.eligibility.tier <= 0) {
          throw new Error(
            status.eligibility?.reason || "Belum eligible untuk claim passport.",
          );
        }

        const issued = await backendPost<PassportIssueSignaturePayload>(
          "/api/passport/issue-signature",
          {},
        );

        const claim = issued?.claim;
        const signature = String(issued?.signature || "");
        if (!claim || !signature) {
          throw new Error(
            "Backend tidak mengembalikan signature passport yang valid.",
          );
        }

        if (
          String(claim.player || "").toLowerCase() !==
          String(playerAddress).toLowerCase()
        ) {
          throw new Error(
            "Signer payload player tidak cocok dengan wallet aktif.",
          );
        }

        let txHash: string;
        try {
          txHash = await writeAndConfirm({
            address: TRUST_PASSPORT_ADDRESS as Address,
            abi: TRUST_PASSPORT_ABI,
            functionName: "claimWithSignature",
            args: [
              {
                player: claim.player as Address,
                tier: Number(claim.tier),
                issuedAt: BigInt(claim.issuedAt),
                expiry: BigInt(claim.expiry),
                nonce: BigInt(claim.nonce),
              },
              signature as Hex,
            ],
          });
        } catch (error) {
          throw new Error(
            toUserFacingWalletError(error, "Claim passport gagal.", {
              userRejectedMessage: "Claim passport dibatalkan di wallet.",
            }),
          );
        }

        return {
          txHash,
          tier: Number(claim.tier),
          expiry: Number(claim.expiry),
          signatureExpiry: Number(issued.signatureExpiry || 0),
        };
      },
      startBet: async (stake: number) => {
        const playerAddress = await requireReadyGameWallet();

        // --- AUTO SETTLE CHECK ---
        try {
          const bridge = window.__CHICKEN_MONAD_BRIDGE__;
          if (bridge?.autoSettlePending) {
            await bridge.autoSettlePending();
          }
        } catch (err) {
          throw new Error(
            toUserFacingWalletError(
              err,
              "Pending settlement belum selesai. Selesaikan dulu sebelum start bet baru.",
              {
                userRejectedMessage:
                  "Settlement session lama dibatalkan di wallet. Selesaikan dulu sebelum start bet lagi.",
              },
            ),
          );
        }

        const stakeAmountUnits = parseUnits(String(stake), USDC_DECIMALS);
        const [availableBalanceUnits, blocker] = await Promise.all([
          readContract(wagmiConfig, {
            address: GAME_VAULT_ADDRESS as Address,
            abi: GAME_VAULT_ABI,
            functionName: "availableBalanceOf",
            args: [playerAddress],
          }) as Promise<bigint>,
          getPlayBlocker(),
        ]);

        if (availableBalanceUnits < stakeAmountUnits) {
          throw new Error(
            `Saldo available vault kurang. Tersedia ${toNumberAmount(availableBalanceUnits).toFixed(2)} USDC, butuh ${stake.toFixed(2)} USDC.`,
          );
        }

        if (blocker.kind !== "none") {
          emitPlayBlocker(blocker);
          throw new Error(
            blocker.kind === "pending_settlement"
              ? "Prev bet masih butuh settlement. Klik END NOW dulu sebelum start bet baru."
              : blocker.onchainSessionId
                ? `Masih ada session onchain lama yang aktif (${shortSessionId(blocker.onchainSessionId)}). Klik END NOW dulu sebelum start bet baru.`
                : "Prev bet masih belum selesai. Klik END NOW dulu sebelum start bet baru.",
          );
        }

        const socket = ensureSocket();
        await waitForSocketReady(socket);

        const pendingStart = createPendingRequest(pendingStartRef);
        socket.emit("game:start", { stake });

        let payload: StartedPayload;
        try {
          payload = await pendingStart;
        } catch (error) {
          throw new Error(
            toUserFacingWalletError(error, "Gagal memulai game di backend."),
          );
        }

        try {
          const txHash = (await writeContract(wagmiConfig, {
            address: GAME_SETTLEMENT_ADDRESS as Address,
            abi: GAME_SETTLEMENT_ABI,
            functionName: "startSession",
            args: [
              payload.onchainSessionId as `0x${string}`,
              BigInt(payload.stakeAmountUnits),
            ],
          })) as string;

          activeSessionIdRef.current = payload.sessionId;

          try {
            await waitForTransactionReceipt(wagmiConfig, {
              hash: txHash as Hash,
            });
          } catch (error) {
            const shouldAbort = shouldAbortStartSessionOnReceiptError(error);

            if (shouldAbort) {
              socket.emit("game:abort_start", {
                sessionId: payload.sessionId,
                txHash,
              });
              throw new Error(
                toStartSessionFailureMessage(
                  error,
                  "Transaksi startSession gagal/revert.",
                ),
              );
            }

            window.dispatchEvent(
              new CustomEvent("chicken:game-error", {
                detail: {
                  message:
                    "Konfirmasi startSession masih pending/network issue. Jangan refresh; cek tx di wallet explorer.",
                },
              }),
            );
          }

          return {
            sessionId: payload.sessionId,
            onchainSessionId: payload.onchainSessionId,
            stake,
            availableBalance: Number.NaN,
            txHash,
          };
        } catch (error) {
          console.error("❌ Smart Contract Revert (startSession):", error);
          socket.emit("game:abort_start", { sessionId: payload.sessionId });
          throw new Error(
            toStartSessionFailureMessage(
              error,
              "Transaksi startSession gagal/revert.",
            ),
          );
        }
      },
      sendMove: (direction: string) => {
        const socket = socketRef.current;
        if (!socket || !socket.connected) return;
        socket.emit("game:move", { direction });
      },
      cashOut: async () => {
        const playerAddress = await requireReadyGameWallet();
        const socket = ensureSocket();
        await waitForSocketReady(socket);

        const pendingCashout = createPendingRequest(pendingCashoutRef);
        socket.emit("game:cashout");

        const payload = await pendingCashout;
        const settlementResolution = payload.resolution || payload.payload;
        const settlementSignature =
          payload.settlementSignature || payload.signature || "";
        if (!settlementResolution) {
          throw new Error("Payload settlement dari backend tidak lengkap.");
        }
        let txHash = String(payload.settlementTxHash || "");
        try {
          if (!txHash && payload.sessionId) {
            const submit = await backendPost<{ success: boolean; txHash?: string }>(
              "/api/game/submit-settlement",
              { sessionId: payload.sessionId },
            );
            txHash = String(submit?.txHash || "");
          }
          if (!txHash) {
            throw new Error("Settlement tx hash belum tersedia.");
          }
        } catch (error) {
          void refreshPlayBlockerStatus();
          throw new Error(
            normalizeError(error, "Settlement cash out gagal diproses backend."),
          );
        }

        activeSessionIdRef.current = "";
        await refreshPlayBlockerStatus();
        return {
          sessionId: payload.sessionId,
          onchainSessionId: payload.onchainSessionId,
          availableBalance: await readAvailableBalance(playerAddress),
          txHash,
          resolution: settlementResolution,
          signature: settlementSignature,
          multiplier: Number(payload.multiplier || "0"),
          payoutAmount: Number(payload.payoutAmount || "0"),
          profit: Number(payload.profit || "0"),
          reason: payload.reason,
        };
      },
      crash: async (reason?: string) => {
        const playerAddress = await requireReadyGameWallet();
        const socket = ensureSocket();
        await waitForSocketReady(socket);

        const pendingCrash = createPendingRequest(pendingCrashRef);
        socket.emit("game:crash", { reason });

        const payload = await pendingCrash;
        const settlementResolution = payload.resolution || payload.payload;
        const settlementSignature =
          payload.settlementSignature || payload.signature || "";

        activeSessionIdRef.current = "";

        if (!settlementResolution) {
          return null;
        }

        let txHash = String(payload.settlementTxHash || "");
        try {
          if (!txHash && payload.sessionId) {
            const submit = await backendPost<{ success: boolean; txHash?: string }>(
              "/api/game/submit-settlement",
              { sessionId: payload.sessionId },
            );
            txHash = String(submit?.txHash || "");
          }
          if (!txHash) {
            throw new Error("Settlement tx hash belum tersedia.");
          }
        } catch (error) {
          void refreshPlayBlockerStatus();
          throw new Error(
            normalizeError(error, "Settlement run gagal diproses backend."),
          );
        }

        await refreshPlayBlockerStatus();
        return {
          sessionId: payload.sessionId,
          onchainSessionId: payload.onchainSessionId,
          availableBalance: await readAvailableBalance(playerAddress),
          txHash,
          resolution: settlementResolution,
          signature: settlementSignature,
          multiplier: Number(payload.multiplier || "0"),
          payoutAmount: Number(payload.payoutAmount || "0"),
          profit: Number(payload.profit || "0"),
          reason: payload.reason,
        };
      },
    };

    void refreshPlayBlockerStatus();

    return () => {
      pendingStartRef.current = null;
      pendingCashoutRef.current = null;
      pendingCrashRef.current = null;
      if (reconnectTimeoutRef.current) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      delete window.__CHICKEN_MONAD_BRIDGE__;
    };
  }, [
    account,
    backgroundMode,
    ensureBackendSession,
    isBackendAuthenticated,
    hasBackendConfig,
    isMonadChain,
    refreshBackendSession,
  ]);

  return null;
}
