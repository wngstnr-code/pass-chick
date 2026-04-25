import { Router, type Request, type Response } from "express";
import { createPublicClient, http, isHex, parseAbi, type Address, type Hex } from "viem";
import { requireAuth } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import { getGameByWallet, hasActiveGame, removeGameState } from "../services/gameState.js";
import { getEffectiveMultiplierBp } from "../services/gameValidator.js";
import {
  SETTLEMENT_OUTCOME,
  signSettlement,
  usdcToUint256,
} from "../services/signatureService.js";
import {
  getSettlementRelayerAddress,
  submitSettlementOnchain,
} from "../services/settlementExecutor.js";

const router = Router();
const settlementPublicClient = createPublicClient({
  transport: http(env.MONAD_RPC_URL),
});
const GAME_SETTLEMENT_READ_ABI = parseAbi([
  "function getSession(bytes32 sessionId) view returns (address player, uint256 stakeAmount, uint64 startedAt, bool active, bool settled)",
]);

function toSettlementErrorMessage(error: unknown) {
  const raw = String(
    (error as { shortMessage?: string; message?: string })?.shortMessage ||
      (error as { message?: string })?.message ||
      "unknown error",
  );
  const lower = raw.toLowerCase();

  if (
    lower.includes("insufficient funds") ||
    lower.includes("funds for gas") ||
    lower.includes("signer had insufficient balance")
  ) {
    return `Failed to submit settlement onchain: backend relayer kehabisan MON untuk gas (relayer: ${getSettlementRelayerAddress()}).`;
  }
  if (lower.includes("enotfound") || lower.includes("fetch failed")) {
    return "Failed to submit settlement onchain: backend gagal mengakses RPC Monad.";
  }
  if (lower.includes("invalidsigner")) {
    return "Failed to submit settlement onchain: signer backend tidak cocok dengan signer di contract.";
  }
  if (lower.includes("invalidsignaturesigner")) {
    return "Failed to submit settlement onchain: signature backend tidak cocok dengan backendSigner onchain.";
  }
  if (lower.includes("sessionalreadysettled")) {
    return "Settlement session ini sudah settled onchain.";
  }
  if (lower.includes("sessionnotactive")) {
    return "Settlement session ini sudah tidak aktif onchain.";
  }
  if (lower.includes("sessionnotfound")) {
    return "Session onchain tidak ditemukan untuk settlement ini.";
  }
  if (lower.includes("resolutionexpired")) {
    return "Settlement signature sudah expired.";
  }
  if (lower.includes("insufficienttreasury")) {
    return "Treasury vault tidak cukup untuk payout settlement ini.";
  }
  if (lower.includes("resolutionpayoutmismatch")) {
    return "Failed to submit settlement onchain: payload payout tidak cocok dengan rule settlement onchain.";
  }
  if (lower.includes("resolutionstakemismatch")) {
    return "Failed to submit settlement onchain: payload stake tidak cocok dengan data session onchain.";
  }
  if (lower.includes("sessionnotactive") || lower.includes("session already settled")) {
    return "Settlement session ini sudah tidak aktif onchain.";
  }

  return `Failed to submit settlement onchain: ${raw}`;
}

function isAlreadySettledLikeError(error: unknown) {
  const raw = String(
    (error as { shortMessage?: string; message?: string })?.shortMessage ||
      (error as { message?: string })?.message ||
      "",
  ).toLowerCase();

  return (
    raw.includes("sessionalreadysettled") ||
    raw.includes("sessionnotactive") ||
    raw.includes("sessionnotfound")
  );
}

function parsePaginationParam(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function getSettlementAmounts(session: Record<string, unknown>) {
  const stakeAmount = Number(session.stake_amount ?? 0);
  const status = String(session.status ?? "");
  const finalMultiplierBp =
    status === "CRASHED"
      ? 0
      : Math.round(Number(session.final_multiplier ?? 0) * 10_000);
  const stakeUnits = usdcToUint256(stakeAmount);
  const payoutUnits =
    status === "CRASHED"
      ? 0n
      : (stakeUnits * BigInt(finalMultiplierBp)) / 10_000n;

  return {
    stakeAmount,
    stakeUnits,
    payoutAmount: Number(payoutUnits) / 1_000_000,
    payoutUnits,
    finalMultiplierBp,
  };
}

function buildResolutionFromSession(walletAddress: string, session: Record<string, unknown>) {
  const status = String(session.status ?? "");
  const { stakeUnits, payoutUnits, finalMultiplierBp } = getSettlementAmounts(session);

  return {
    sessionId: String(session.onchain_session_id),
    player: walletAddress,
    stakeAmount: stakeUnits.toString(),
    payoutAmount: payoutUnits.toString(),
    finalMultiplierBp: status === "CRASHED" ? "0" : finalMultiplierBp.toString(),
    outcome: status === "CRASHED" ? 2 : 1,
    deadline: String(session.settlement_deadline ?? "0"),
  };
}

async function submitSettlementForSession(params: {
  walletAddress: string;
  session: Record<string, unknown>;
}) {
  const { walletAddress, session } = params;
  const sessionId = String(session.session_id ?? "");
  const existingTxHash = String(session.settlement_tx_hash ?? "").trim();
  if (existingTxHash) {
    return existingTxHash;
  }

  const ensuredSettlement = await ensureSettlementSignature(walletAddress, session);
  if (!ensuredSettlement?.signature || !ensuredSettlement.deadline) {
    throw new Error("Settlement signature belum tersedia.");
  }

  const normalizedSession = {
    ...session,
    settlement_signature: ensuredSettlement.signature,
    settlement_deadline: ensuredSettlement.deadline,
  };
  const resolution = buildResolutionFromSession(walletAddress, normalizedSession);
  let txHash: string;
  try {
    txHash = await submitSettlementOnchain({
      resolution,
      signature: ensuredSettlement.signature,
    });
  } catch (firstSubmitError) {
    const refreshedSettlement = await ensureSettlementSignature(walletAddress, session, {
      forceRefresh: true,
    });

    if (!refreshedSettlement?.signature || !refreshedSettlement.deadline) {
      throw firstSubmitError;
    }

    const retrySession = {
      ...session,
      settlement_signature: refreshedSettlement.signature,
      settlement_deadline: refreshedSettlement.deadline,
    };

    txHash = await submitSettlementOnchain({
      resolution: buildResolutionFromSession(walletAddress, retrySession),
      signature: refreshedSettlement.signature,
    });
  }

  const { error } = await supabase
    .from("game_sessions")
    .update({ settlement_tx_hash: txHash })
    .eq("session_id", sessionId)
    .eq("wallet_address", walletAddress);

  if (error) {
    throw error;
  }

  return txHash;
}

async function clearUnsettlablePendingSession(sessionId: string) {
  const { error } = await supabase
    .from("game_sessions")
    .update({
      settlement_signature: null,
      settlement_deadline: null,
      settlement_tx_hash: "not-pending-onchain",
    })
    .eq("session_id", sessionId);

  if (error) {
    console.error(`❌ Failed to clear stale pending settlement ${sessionId}:`, error);
  }
}

async function applyCrashPlayerStats(walletAddress: string, stakeAmount: number) {
  const { data: player } = await supabase
    .from("players")
    .select("total_losses, total_profit")
    .eq("wallet_address", walletAddress)
    .single();

  if (!player) {
    return;
  }

  await supabase
    .from("players")
    .update({
      total_losses: Number(player.total_losses ?? 0) + 1,
      total_profit: Number(player.total_profit ?? 0) - stakeAmount,
    })
    .eq("wallet_address", walletAddress);
}

async function crashAndPersistSession(params: {
  walletAddress: string;
  sessionId: string;
  onchainSessionId: string;
  stakeAmount: number;
  maxRowReached?: number;
  finalMultiplier?: number;
}) {
  const settlement = await signSettlement({
    playerAddress: params.walletAddress,
    onchainSessionId: params.onchainSessionId,
    stakeAmount: params.stakeAmount,
    payoutAmount: 0,
    finalMultiplierBp: 0,
    outcome: SETTLEMENT_OUTCOME.CRASHED,
  });

  const updates: Record<string, unknown> = {
    status: "CRASHED",
    final_multiplier: params.finalMultiplier ?? 0,
    payout_amount: 0,
    settlement_signature: settlement.signature,
    settlement_deadline: settlement.resolution.deadline,
    settlement_tx_hash: null,
    ended_at: new Date().toISOString(),
  };

  if (typeof params.maxRowReached === "number") {
    updates.max_row_reached = params.maxRowReached;
  }

  const { error } = await supabase
    .from("game_sessions")
    .update(updates)
    .eq("session_id", params.sessionId)
    .eq("wallet_address", params.walletAddress);

  if (error) {
    throw error;
  }

  await applyCrashPlayerStats(params.walletAddress, params.stakeAmount);

  return settlement;
}

async function ensureSettlementSignature(
  walletAddress: string,
  session: Record<string, unknown>,
  options?: { forceRefresh?: boolean },
) {
  const forceRefresh = Boolean(options?.forceRefresh);
  const existingSignature = String(session.settlement_signature ?? "").trim();
  const existingDeadline = Number(session.settlement_deadline ?? 0);
  const now = Math.floor(Date.now() / 1000);
  const minValidSeconds = 30;

  if (
    !forceRefresh &&
    existingSignature &&
    existingDeadline > 0 &&
    existingDeadline > now + minValidSeconds
  ) {
    return {
      signature: existingSignature,
      deadline: existingDeadline,
    };
  }

  const status = String(session.status ?? "");
  if (status !== "CRASHED" && status !== "CASHED_OUT") {
    return null;
  }

  try {
    const { stakeAmount, payoutAmount, finalMultiplierBp } =
      getSettlementAmounts(session);
    const settlement = await signSettlement({
      playerAddress: walletAddress,
      onchainSessionId: String(session.onchain_session_id ?? ""),
      stakeAmount,
      payoutAmount,
      finalMultiplierBp,
      outcome:
        status === "CRASHED"
          ? SETTLEMENT_OUTCOME.CRASHED
          : SETTLEMENT_OUTCOME.CASHED_OUT,
    });

    const nextSignature = settlement.signature;
    const nextDeadline = Number(settlement.resolution.deadline);

    const { error } = await supabase
      .from("game_sessions")
      .update({
        payout_amount: payoutAmount,
        settlement_signature: nextSignature,
        settlement_deadline: nextDeadline,
      })
      .eq("session_id", String(session.session_id));

    if (error) {
      console.error(
        `❌ Failed to persist generated settlement signature ${String(session.session_id)}:`,
        error,
      );
    }

    return {
      signature: nextSignature,
      deadline: nextDeadline,
    };
  } catch (signError) {
    console.error(
      `❌ Failed to generate settlement signature for ${String(session.session_id)}:`,
      signError,
    );
    return null;
  }
}

async function isCurrentOnchainPendingSettlement(session: Record<string, unknown>) {
  const onchainSessionId = String(session.onchain_session_id ?? "");
  if (!isHex(onchainSessionId, { strict: true })) {
    return false;
  }

  try {
    const onchainSession = await settlementPublicClient.readContract({
      address: env.GAME_SETTLEMENT_ADDRESS as Address,
      abi: GAME_SETTLEMENT_READ_ABI,
      functionName: "getSession",
      args: [onchainSessionId as Hex],
    });

    const player = onchainSession[0];
    const active = onchainSession[3];
    const settled = onchainSession[4];

    if (!player || /^0x0{40}$/i.test(player)) {
      return false;
    }

    return Boolean(active && !settled);
  } catch (inspectError) {
    console.error(`❌ Failed to inspect pending settlement ${onchainSessionId}:`, inspectError);
    return true;
  }
}

router.get("/active", requireAuth, async (req: Request, res: Response) => {
  const walletAddress = req.walletAddress!;

  if (hasActiveGame(walletAddress)) {
    res.json({ hasActiveGame: true });
    return;
  }

  const { data } = await supabase
    .from("game_sessions")
    .select("session_id, onchain_session_id, stake_amount, created_at")
    .eq("wallet_address", walletAddress)
    .eq("status", "ACTIVE")
    .maybeSingle();

  res.json({
    hasActiveGame: !!data,
    session: data || null,
  });
});

async function forceEndActiveSession(req: Request, res: Response) {
  const walletAddress = req.walletAddress!;
  const activeGame = getGameByWallet(walletAddress);

  if (activeGame) {
    const effectiveMultiplierBp = activeGame.timer.segmentActive
      ? getEffectiveMultiplierBp(
          activeGame.multiplierBp,
          activeGame.timer.segmentStart,
          Date.now(),
        )
      : activeGame.multiplierBp;

    try {
      await crashAndPersistSession({
        walletAddress,
        sessionId: activeGame.sessionId,
        onchainSessionId: activeGame.onchainSessionId,
        stakeAmount: activeGame.stake,
        maxRowReached: activeGame.maxRow,
        finalMultiplier: effectiveMultiplierBp / 10_000,
      });
      removeGameState(walletAddress);
      res.json({
        success: true,
        resolved: true,
        source: "memory",
        sessionId: activeGame.sessionId,
        onchainSessionId: activeGame.onchainSessionId,
      });
      return;
    } catch (error) {
      console.error("❌ Failed to force-end active in-memory game:", error);
      res.status(500).json({ error: "Failed to force-end active game." });
      return;
    }
  }

  const { data: staleSession, error } = await supabase
    .from("game_sessions")
    .select("session_id, onchain_session_id, stake_amount, max_row_reached")
    .eq("wallet_address", walletAddress)
    .eq("status", "ACTIVE")
    .maybeSingle();

  if (error) {
    console.error("❌ Failed to query active game session:", error);
    res.status(500).json({ error: "Failed to inspect active session." });
    return;
  }

  if (!staleSession) {
    res.json({ success: true, resolved: false, source: "none" });
    return;
  }

  try {
    await crashAndPersistSession({
      walletAddress,
      sessionId: String(staleSession.session_id),
      onchainSessionId: String(staleSession.onchain_session_id),
      stakeAmount: Number(staleSession.stake_amount ?? 0),
      maxRowReached: Number(staleSession.max_row_reached ?? 0),
      finalMultiplier: 0,
    });
    res.json({
      success: true,
      resolved: true,
      source: "database",
      sessionId: staleSession.session_id,
      onchainSessionId: staleSession.onchain_session_id,
    });
  } catch (forceEndError) {
    console.error("❌ Failed to force-end stale active session:", forceEndError);
    res.status(500).json({ error: "Failed to force-end stale active session." });
  }
}

async function getPendingSettlements(req: Request, res: Response) {
  const walletAddress = req.walletAddress!;

  const { data, error } = await supabase
    .from("game_sessions")
    .select(
      "session_id, onchain_session_id, stake_amount, status, final_multiplier, payout_amount, settlement_signature, settlement_deadline, settlement_tx_hash, ended_at"
    )
    .eq("wallet_address", walletAddress)
    .in("status", ["CASHED_OUT", "CRASHED"])
    .is("settlement_tx_hash", null)
    .order("ended_at", { ascending: false })
    .limit(5);

  if (error) {
    console.error("❌ Supabase Error (pending-settlements):", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });
    res.status(500).json({ error: "Failed to fetch pending settlements.", details: error.message });
    return;
  }

  const pendingSettlements: Array<Record<string, unknown>> = [];

  for (const session of data || []) {
    const isStillPendingOnchain = await isCurrentOnchainPendingSettlement(session);
    if (!isStillPendingOnchain) {
      console.warn(
        `🧹 Ignoring stale pending settlement ${String(session.session_id)} (${String(
          session.onchain_session_id ?? "",
        )})`,
      );
      await clearUnsettlablePendingSession(String(session.session_id));
      continue;
    }

    const ensuredSettlement = await ensureSettlementSignature(walletAddress, session);
    if (!ensuredSettlement?.signature || !ensuredSettlement.deadline) {
      console.warn(
        `⚠️ Pending session ${String(session.session_id)} has no usable settlement signature yet.`,
      );
      continue;
    }

    const normalizedSession = {
      ...session,
      settlement_signature: ensuredSettlement.signature,
      settlement_deadline: ensuredSettlement.deadline,
    };

    pendingSettlements.push({
      ...normalizedSession,
      resolution: buildResolutionFromSession(walletAddress, normalizedSession),
      signature: ensuredSettlement.signature,
    });
  }

  res.json({
    pendingSettlements,
    pendingClaims: pendingSettlements,
    hasPending: pendingSettlements.length > 0,
  });
}

router.get("/pending-settlement", requireAuth, getPendingSettlements);
router.get("/pending-claim", requireAuth, getPendingSettlements);
router.post("/force-end-active", requireAuth, forceEndActiveSession);

router.get("/history", requireAuth, async (req: Request, res: Response) => {
  const walletAddress = req.walletAddress!;
  const limit = parsePaginationParam(req.query.limit, 20, 1, 100);
  const offset = parsePaginationParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  const { data, error, count } = await supabase
    .from("game_sessions")
    .select("*", { count: "exact" })
    .eq("wallet_address", walletAddress)
    .neq("status", "ACTIVE")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("❌ Error fetching game history:", error);
    res.status(500).json({ error: "Failed to fetch game history." });
    return;
  }

  res.json({
    sessions: data || [],
    total: count || 0,
    limit,
    offset,
  });
});

async function clearSettlement(req: Request, res: Response) {
  const walletAddress = req.walletAddress!;
  const { sessionId, txHash } = req.body as { sessionId?: string; txHash?: string };

  if (!sessionId || !txHash) {
    res.status(400).json({ error: "Missing sessionId or txHash." });
    return;
  }

  const normalizedTxHash = String(txHash).trim();
  if (!isHex(normalizedTxHash, { strict: true }) || normalizedTxHash.length !== 66) {
    res.status(400).json({ error: "Invalid txHash format." });
    return;
  }

  const { data: session } = await supabase
    .from("game_sessions")
    .select("session_id, wallet_address, status, settlement_signature, settlement_tx_hash")
    .eq("session_id", sessionId)
    .eq("wallet_address", walletAddress)
    .single();

  if (!session) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  const status = String(session.status ?? "");
  if (status !== "CASHED_OUT" && status !== "CRASHED") {
    res.status(409).json({ error: "Session belum siap untuk clear settlement." });
    return;
  }

  if (!session.settlement_signature) {
    res.status(409).json({ error: "Settlement signature belum tersedia." });
    return;
  }

  if (session.settlement_tx_hash) {
    res.json({ success: true });
    return;
  }

  await supabase
    .from("game_sessions")
    .update({ settlement_tx_hash: normalizedTxHash })
    .eq("session_id", sessionId);

  res.json({ success: true });
}

async function submitSettlement(req: Request, res: Response) {
  const walletAddress = req.walletAddress!;
  const { sessionId } = req.body as { sessionId?: string };

  if (!sessionId) {
    res.status(400).json({ error: "Missing sessionId." });
    return;
  }

  const { data: session, error } = await supabase
    .from("game_sessions")
    .select(
      "session_id, wallet_address, onchain_session_id, stake_amount, status, final_multiplier, payout_amount, settlement_signature, settlement_deadline, settlement_tx_hash"
    )
    .eq("session_id", sessionId)
    .eq("wallet_address", walletAddress)
    .single();

  if (error || !session) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  const status = String(session.status ?? "");
  if (status !== "CASHED_OUT" && status !== "CRASHED") {
    res.status(409).json({ error: "Session belum siap untuk settlement." });
    return;
  }

  try {
    const txHash = await submitSettlementForSession({
      walletAddress,
      session: session as Record<string, unknown>,
    });
    res.json({ success: true, txHash });
  } catch (submitError) {
    console.error(`❌ Failed to submit settlement ${sessionId}:`, submitError);

    if (isAlreadySettledLikeError(submitError)) {
      // If chain state already closed, don't keep blocking new runs.
      await supabase
        .from("game_sessions")
        .update({ settlement_tx_hash: "already-settled-onchain" })
        .eq("session_id", sessionId)
        .eq("wallet_address", walletAddress);

      res.json({ success: true, txHash: "already-settled-onchain" });
      return;
    }

    res.status(500).json({ error: toSettlementErrorMessage(submitError) });
  }
}

router.post("/clear-settlement", requireAuth, clearSettlement);
router.post("/clear-claim", requireAuth, clearSettlement);
router.post("/submit-settlement", requireAuth, submitSettlement);

export default router;
