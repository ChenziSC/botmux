/**
 * In-memory broker for `botmux ask` (v0.1.8).
 *
 * Holds the pending-ask registry, runs the deadline timers, and arbitrates
 * click resolution. IM-agnostic: the im/lark side wires a dispatcher via
 * `setCardDispatcher` so the broker doesn't import Lark types.
 *
 * §3 / §6 / §7 / §8 of /tmp/botmux-ask.md.
 */

import { randomUUID } from 'node:crypto';

import { logger } from '../utils/logger.js';
import {
  askKeyFor,
  dispatchUuidForKey,
  HANDOFF_RETENTION_MS,
  type AskPersistStore,
  type PersistedAsk,
} from './ask-persist-store.js';
import type {
  AskCardDispatcher,
  AskClickOutcome,
  AskResult,
  CreateAskInput,
  PendingAsk,
} from './ask-types.js';
import { AskDispatchError } from './ask-types.js';
import { ManagedAskError, parseManagedDeliveryContext, validAskOriginalTurn } from './managed-ask-types.js';
import type { PersistedManagedAsk } from './managed-ask-store.js';

/** Origins for which restart-resume + durable handoff are enabled. Only a
 *  caller that has a reconnecting claimant after a daemon restart may persist:
 *  the hook process survives in the CLI's tmux/persistent-backend session and
 *  re-POSTs with the same requestId. An explicit `botmux ask buttons` CLI exits
 *  on restart (no claimant) and a PTY-backend hook doesn't survive, so those
 *  must NOT persist/handoff — else they leave orphan records (codex P1-4). */
const RESUMABLE_ORIGINS = new Set(['hook']);

interface InternalPending extends Omit<PendingAsk, 'selections'> {
  managedRecord?: PersistedManagedAsk;
  persistenceRetryHandle?: NodeJS.Timeout;
  persistenceRetryCount?: number;
  pendingSystemResult?: AskResult;
  managedExpiryHandle?: NodeJS.Timeout;
  /** Stable identity = larkAppId.sessionId.originKind.requestId (see
   *  ask-persist-store.askKeyFor). NOT a bearer secret — scoped to the
   *  authenticated session so another session can't reclaim by reusing a
   *  requestId (codex P1-3). */
  askKey: string;
  /** Per-invocation id (hook generates once, reuses across reconnect retries). */
  requestId: string;
  /** Caller kind ('hook' | 'explicit' | …) namespacing the identity. */
  originKind: string;
  /** Whether this ask is eligible for persistence + restart resume (its origin
   *  has a reconnecting claimant). */
  resumable: boolean;
  /** Waiter Promise resolvers. Normally one; an active same-requestId replay
   *  (client reset mid-POST → re-POST) JOINS the same ask and adds another
   *  waiter here so all callers get the one result — no second ask/card
   *  (codex P1-1 active-replay). */
  waiters: Array<(result: AskResult) => void>;
  timeoutHandle?: NodeJS.Timeout;
  /** Relative timeout retained so host-owned asks can start the human action
   *  window only after the card is confirmed delivered. */
  timeoutMs: number;
  timeoutStartsAfterDelivery: boolean;
  timeoutStartedAt?: number;
  /** epoch ms when settle ran; undefined while still pending. */
  settledAt?: number;
  /** Terminal result, retained briefly after settle so a same-requestId replay
   *  in the ambiguous window gets the identical answer instead of a stale/new
   *  ask (codex P1-1). */
  terminalResult?: AskResult;
  /**
   * Restored from disk after a daemon restart, not yet re-claimed. See
   * reattachByRequest for the two sub-cases (awaiting click / stashed answer).
   */
  dormant?: boolean;
  /** Durable handoff: a terminal result that arrived while dormant, held until
   *  the reconnecting hook claims it. */
  answeredResult?: AskResult;
  /** Absolute-expiry timer for an unclaimed handoff stash (codex P1-4). Armed on
   *  stash + on restore-of-a-stashed-answer; fires at answeredAt + retention to
   *  reap memory + disk together. Cleared when the hook claims the stash. */
  handoffExpiryHandle?: NodeJS.Timeout;
  /**
   * 按问题序号（questionIndex）累积的勾选 key 集合。
   */
  selections: Map<number, Set<string>>;
}

const pending = new Map<string, InternalPending>();
let dispatcher: AskCardDispatcher | null = null;

/** Injected durable store (codex P1-4: no global-dataDir reads from the broker).
 *  Wired once at daemon bootstrap via setAskPersistStore; null → persistence is
 *  a no-op (unit tests that don't exercise restart-resume需要绑定各自 temp
 *  store，绝不回落到全局目录). */
let persistStore: AskPersistStore | null = null;

/** Effective handoff-retention window. Defaults to the durable-store constant;
 *  a test may shrink it via `_setHandoffRetentionForTest` so the absolute-expiry
 *  reaper (codex P1-4) can be exercised with real timers instead of a 24h wait
 *  or fake-timer gymnastics around the async dispatch loop. */
let handoffRetentionMs: number = HANDOFF_RETENTION_MS;

/** Wire the durable persist store. Called once at daemon bootstrap with the
 *  real dir; tests inject a temp store (and only clean their own sentinel dir). */
export function setAskPersistStore(store: AskPersistStore | null): void {
  persistStore = store;
}

/** Shrink the handoff-retention window — for tests only, so the absolute-expiry
 *  reaper (codex P1-4) can be verified with a short real timer. Restored to the
 *  default by `_resetForTest`. */
export function _setHandoffRetentionForTest(ms: number): void {
  handoffRetentionMs = ms;
}

/** Optional actor context for the talk check. Card-click paths (toggle/submit)
 *  omit it — Lark card-action callbacks carry no sender union / bot flag, so the
 *  checker degrades to the human `evaluateTalk(openId, chatType)`. The custom
 *  text-reply path (submitCustomReply) DOES have the full message event, so it
 *  passes actor context and the checker dispatches to the same predicate as the
 *  dispatcher gate / quota recheck (bot → evaluateBotTalk, human → evaluateTalk
 *  with the teamMember union leg). Without this, a cross-deployment team bot or a
 *  platform teamMember human answering by text is wrongly rejected. */
export interface AskAnswerActor {
  /** Feishu-stamped bot sender (sender_type ∈ app|bot, or a cross-ref sibling). */
  botSender?: boolean;
  /** Bot-locked union (evaluateTalk teamBot leg / evaluateBotTalk). */
  senderUnionId?: string;
  /** Raw sender union (evaluateTalk teamMember leg — may be a human union). */
  memberUnionId?: string;
}

/** IM-side canTalk predicate, wired by the daemon at bootstrap. Lets the broker
 *  honour the bot's canTalk gate without importing Lark types: whoever may
 *  address the bot in this chat may answer its `botmux ask`. Returns false until
 *  wired, so an unwired broker authorizes no one (daemon always wires it).
 *  `actor` carries optional union / bot context (see AskAnswerActor); omitted on
 *  card-click paths, supplied on the text-reply path. */
let canTalkChecker:
  | ((larkAppId: string, chatId: string, openId: string, chatType?: 'group' | 'p2p', actor?: AskAnswerActor) => boolean)
  | null = null;

/** Wire the canTalk predicate. Called once during daemon bootstrap. */
export function setCanTalkChecker(
  fn: (larkAppId: string, chatId: string, openId: string, chatType?: 'group' | 'p2p', actor?: AskAnswerActor) => boolean,
): void {
  canTalkChecker = fn;
}

/** A click is authorized iff the clicker may `canTalk` to the bot in this chat.
 *  `botmux ask` is a talk-level interaction (answering the agent's question),
 *  so it follows the canTalk gate — not the stricter canOperate / allowedUsers.
 *  `actor` is only supplied by the text-reply path; card clicks omit it. */
export function isAuthorizedToAnswer(ask: Pick<InternalPending, 'answererOpenId' | 'larkAppId' | 'chatId' | 'chatType'>, by: string, actor?: AskAnswerActor): boolean {
  if (ask.answererOpenId && ask.answererOpenId !== by) return false;
  return canTalkChecker?.(ask.larkAppId, ask.chatId, by, ask.chatType, actor) ?? false;
}

/** Window during which a settled ask is still queryable so race-losers get a
 *  precise `already_settled` outcome (and the card click handler can show
 *  "已被 X 答了" instead of a generic "已失效"). After this window expires,
 *  late clicks fall through to `stale` like any forgotten id. */
const SETTLED_RETENTION_MS = 60_000;

/** Wire the IM-side dispatcher. Called once during daemon bootstrap from
 *  daemon.ts after im/lark/ask-card.ts is constructed. */
export function setCardDispatcher(d: AskCardDispatcher): void {
  dispatcher = d;
}

/** Register a new pending ask. Returns a Promise that settles when:
 *   - a valid click arrives (`kind:'answered'`)
 *   - the deadline elapses (`kind:'timedOut'`)
 *   - the broker invalidates the ask (`kind:'invalidated'`)
 *
 *  Side effects:
 *   - generates askId + nonce
 *   - starts the deadline timer
 *   - dispatches the card; if the card send fails, the ask is immediately
 *     invalidated and the Promise settles with `kind:'invalidated'`.
 *
 *  Throws synchronously only if no dispatcher has been wired — that's a
 *  daemon-misconfiguration bug, not a runtime ask failure.
 */
export function registerAsk(input: CreateAskInput): Promise<AskResult> {
  return registerAskInternal(input, false);
}

/**
 * Register a restart-safe ask whose reconnecting claimant is the daemon host,
 * not a surviving CLI hook.  Keep this as a separate entry point rather than a
 * caller-controlled flag on CreateAskInput: `/api/asks` must never let an
 * untrusted CLI manufacture an orphanable host-owned record by choosing an
 * origin string.
 */
export function registerHostAsk(input: CreateAskInput): Promise<AskResult> {
  return registerAskInternal(input, true);
}

function registerAskInternal(input: CreateAskInput, hostManaged: boolean): Promise<AskResult> {
  if (!dispatcher) {
    throw new Error('ask-broker: cardDispatcher not wired — daemon bootstrap bug');
  }

  if (input.managedDelivery) input = { ...input,
    managedDelivery: parseManagedDeliveryContext(input.managedDelivery) ?? input.managedDelivery,
  };
  const originKind = input.originKind ?? 'hook';
  if (input.managedDelivery && (!parseManagedDeliveryContext(input.managedDelivery)
    || !input.requestId || originKind !== 'explicit' || !validAskOriginalTurn(input.originalTurn))) {
    throw new ManagedAskError('managed_ask_identity_required', 400);
  }
  if (input.managedDelivery && input.waiterSignal?.aborted) throw new ManagedAskError('managed_ask_waiter_disconnected');
  if (input.managedDelivery && !persistStore?.managed) throw new ManagedAskError('managed_ask_store_unavailable');
  // CLI-origin resumability is gated by TWO independent facts (codex P1-4):
  //  1. the origin has a reconnecting claimant (only 'hook' re-POSTs after a
  //     restart; an explicit `botmux ask buttons` process exits), AND
  //  2. the issuing session's backend actually SURVIVES a daemon restart —
  //     computed by the daemon from the authenticated session's frozen backend
  //     (tmux/herdr/zellij/zmx), NOT trusted from the client. A PTY-backed hook
  //     dies with the daemon, so persisting it would orphan a record no one can
  //     ever re-claim. Undefined backend signal → false (fail closed).
  // A host-managed ask has a different reconnecting claimant: the daemon
  // recovers its matching durable Session record and re-registers through the
  // non-IPC registerHostAsk entry point. Both kinds require a stable requestId.
  const resumable = input.requestId !== undefined && (
    hostManaged
      ? originKind.startsWith('host_cross_principal_')
      : RESUMABLE_ORIGINS.has(originKind) && input.backendSurvivesRestart === true
  );
  // Invocation identity: prefer the caller-supplied requestId (hook generates it
  // once and reuses it across reconnect retries). A caller without one (explicit
  // `botmux ask buttons`) gets a synthesized id and is NOT resumable — it has no
  // reconnecting claimant, so persisting/handing off would orphan (codex P1-4).
  const requestId = input.requestId ?? randomUUID();
  // Identity is SCOPED to the authenticated (larkAppId, sessionId): a requestId
  // is an idempotency id, never a bearer secret — a different session reusing it
  // lands on a different key and can't reclaim this ask (codex P1-3).
  const askKey = askKeyFor(input.larkAppId, input.sessionId, originKind, requestId);

  // Same-key handling — covers ALL states of an existing entry with this key
  // (codex P1-1). The scoped key already pins (app/session/origin/request); here
  // we additionally require the FULL immutable identity (chat/root/questions) to
  // match before joining/replaying/re-attaching.
  let existing = findByKey(askKey);
  if (persistStore?.managed && input.requestId) {
    const saved = persistStore!.managed!.get(askKey);
    if (!saved.found && saved.reason !== 'not_found') throw new ManagedAskError(`managed_ask_${saved.reason}`);
    if (saved.found) {
      if (!existing) existing = restoreManagedAsk(saved.record);
      else existing.managedRecord = saved.record;
    }
  }
  if (existing) {
    if (sameIdentity(existing, input)) {
      if (existing.managedRecord) {
        if (existing.managedRecord.resultExpired || (existing.managedRecord.expiresAt ?? Infinity) <= Date.now()) {
          throw new ManagedAskError('managed_ask_result_expired', 409);
        }
        if (existing.managedRecord.continuation) throw new ManagedAskError('managed_ask_consumption_transferred', 409);
        if (existing.terminalResult) return Promise.resolve(existing.terminalResult);
      }
      if (existing.managedRecord && !existing.settled) {
        if (existing.waiters.length) throw new ManagedAskError('managed_ask_waiter_attached', 409);
        existing.dormant = false;
        const waiter = managedWaiter(existing, input.waiterSignal);
        if (!existing.cardMessageId && existing.deadlineAt > Date.now()) sendCardForAsk(existing);
        return waiter;
      }
      // active (still awaiting a click): add another waiter → both callers get the
      // one result; no second ask, no second card.
      if (!existing.settled && !existing.dormant) {
        logger.info?.(`ask-broker: active replay joined ask ${existing.askId} (key=${askKey})`);
        return new Promise<AskResult>((resolve) => { existing.waiters.push(resolve); });
      }
      // recent-terminal (settled, still retained): return the same terminal result.
      if (existing.settled && existing.terminalResult && !existing.dormant) {
        logger.info?.(`ask-broker: replay returned retained terminal result for ${existing.askId}`);
        return Promise.resolve(existing.terminalResult);
      }
      // dormant (restored after restart): re-attach (handoff or fresh waiter).
      if (existing.dormant) {
        return reattachByRequest(existing);
      }
    } else {
      // Same key, DIFFERENT immutable identity (crafted / stale-but-mutated
      // re-POST). FAIL CLOSED (codex P1-2): never fall through to a second ask —
      // that would post an ambiguous second card and a click could resolve
      // either. The caller gets a terminal `invalidated` and no card is sent.
      logger.warn?.(
        `ask-broker: identity mismatch on key ${askKey} (existing ask ${existing.askId}) — rejecting re-register`,
      );
      if (input.managedDelivery || existing.managedRecord) throw new ManagedAskError('managed_ask_identity_conflict', 409);
      return Promise.resolve<AskResult>({
        kind: 'invalidated',
        reason: 'ask identity mismatch (same key, different question set / chat)',
        selected: null, by: null, comment: null, timedOut: false,
      });
    }
  }

  const askId = randomUUID();
  const nonce = randomUUID().slice(0, 8);
  const createdAt = Date.now();
  const deadlineAt = createdAt + input.timeoutMs;

  return new Promise<AskResult>((resolve, reject) => {
    const selections = new Map<number, Set<string>>();
    for (let i = 0; i < input.questions.length; i++) selections.set(i, new Set<string>());

    const ask: InternalPending = {
      askId,
      askKey,
      requestId,
      originKind,
      resumable,
      nonce,
      larkAppId: input.larkAppId,
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      sessionId: input.sessionId,
      chatType: input.chatType,
      answererOpenId: input.answererOpenId,
      questions: input.questions,
      replyCardTarget: input.replyCardTarget,
      managedDelivery: input.managedDelivery,
      originalTurn: input.originalTurn,
      createdAt,
      deadlineAt,
      settled: false,
      waiters: [resolve],
      timeoutMs: input.timeoutMs,
      timeoutStartsAfterDelivery: hostManaged,
      selections,
    };
    if (input.managedDelivery) {
      ask.managedRecord = {
        v: 3, askId, askKey, requestId, originKind, nonce,
        larkAppId: ask.larkAppId, sessionId: ask.sessionId, chatId: ask.chatId, rootMessageId: ask.rootMessageId,
        chatType: ask.chatType, answererOpenId: ask.answererOpenId, questions: ask.questions, createdAt, deadlineAt, timeoutMs: input.timeoutMs,
        replyCardTarget: input.replyCardTarget, selections: input.questions.map(() => []), phase: 'pending',
        deliveryContext: input.managedDelivery, originalTurn: input.originalTurn!,
        execution: input.originalExecution, handoffPreview: input.managedHandoffPreview,
        presentation: { state: 'none', revision: 0 },
      };
      // Creation is durable BEFORE publishing memory, starting timers, or sending a card.
      ask.managedRecord = persistStore!.managed!.create(ask.managedRecord!);
    }
    if (!hostManaged) armAskTimeout(ask, input.timeoutMs, createdAt);
    pending.set(askId, ask);
    if (ask.managedRecord) {
      ask.waiters = [];
      managedWaiter(ask, input.waiterSignal).then(resolve, reject);
    }
    // Persist ONLY resumable origins (codex P1-4). A restart before the card
    // lands still leaves a resumable record; restore/re-attach re-sends.
    if (resumable) {
      persistFromInternal(ask);
      logger.info?.(`ask-broker: registered + persisted ask ${askId} (key=${askKey}, session=${input.sessionId})`);
    }
    void sendCardForAsk(ask);
  });
}

/** Immutable-identity equality: a reattach/replay must match the ORIGINAL ask on
 *  every caller-independent field, not just the (already-scoped) key. Guards
 *  against a stale/crafted requestId landing on a mismatched ask (codex P1-3). */
function sameIdentity(ask: InternalPending, input: CreateAskInput): boolean {
  return (
    ask.larkAppId === input.larkAppId &&
    ask.sessionId === input.sessionId &&
    ask.chatId === input.chatId &&
    ask.rootMessageId === input.rootMessageId &&
    ask.originKind === (input.originKind ?? 'hook') &&
    ask.answererOpenId === input.answererOpenId &&
    JSON.stringify(ask.managedDelivery) === JSON.stringify(input.managedDelivery) &&
    JSON.stringify(ask.originalTurn) === JSON.stringify(input.originalTurn) &&
    questionsShape(ask.questions) === questionsShape(input.questions)
  );
}

/** Stable shape string for question-set equality (prompt + multiSelect + each
 *  option's key AND label, order-sensitive). Two question sets that would render
 *  a DIFFERENT card to the user — including a relabelled option whose key is
 *  unchanged — must not re-attach/replay (codex P1-2). */
function questionsShape(qs: PendingAsk['questions']): string {
  return JSON.stringify(
    qs.map((q) => ({
      p: q.prompt,
      m: !!q.multiSelect,
      o: q.options.map((o) => [o.key, o.label]),
    })),
  );
}

/** Max card (re-)dispatch attempts on transient failures before giving up and
 *  invalidating. Small: a card send is a single Feishu POST; if a handful of
 *  attempts across a few seconds all fail transiently, the chat is unreachable
 *  and waiting longer won't help. */
const CARD_DISPATCH_MAX_ATTEMPTS = 4;
/** Base backoff between transient re-sends (linear: base × attempt, capped). */
const CARD_DISPATCH_BACKOFF_MS = 500;
const CARD_DISPATCH_BACKOFF_CAP_MS = 4_000;

/** Dispatch (or idempotently re-dispatch) the card and record its messageId. The
 *  dispatcher gets a stable `dispatchUuid` (derived from the scoped key) so any
 *  re-send — a bounded transient retry here, or a restart re-attach — returns the
 *  ORIGINAL message_id instead of posting a duplicate (codex P1-1/P1-3).
 *
 *  Retry policy (codex P1-3 partial-success): a `retryable` AskDispatchError
 *  (5xx/429/network) is retried up to CARD_DISPATCH_MAX_ATTEMPTS with linear
 *  backoff, reusing the SAME uuid — so a send that landed server-side before the
 *  socket broke converges to one logical card. A non-retryable error
 *  (deterministic 4xx / withdrawn) — or a plain untyped throw (fail closed) —
 *  invalidates immediately. */
function sendCardForAsk(ask: InternalPending): void {
  void (async () => {
    for (let attempt = 1; attempt <= CARD_DISPATCH_MAX_ATTEMPTS; attempt++) {
      // Bail if the ask settled out from under us (timeout / invalidate / a click
      // on a restored dormant card) — nothing left to dispatch.
      const live = pending.get(ask.askId);
      if (!live || live.settled) return;
      try {
        // The displayed deadline is a best estimate made immediately before
        // dispatch. Correctness does not depend on it: the broker clock below
        // starts only after the Lark API confirms delivery.
        if (live.timeoutStartsAfterDelivery && live.timeoutStartedAt === undefined) {
          live.deadlineAt = Date.now() + live.timeoutMs;
        }
        const { messageId } = await dispatcher!.send(snapshot(ask));
        const cur = pending.get(ask.askId);
        if (cur === ask && (!cur.settled || cur.managedRecord)) {
          cur.cardMessageId = messageId;
          if (!cur.settled && cur.timeoutStartsAfterDelivery && cur.timeoutStartedAt === undefined) {
            armAskTimeout(cur, cur.timeoutMs, Date.now());
          }
          if (cur.resumable || cur.managedRecord) persistFromInternal(cur);
          if (cur.settled) publishManagedStatus(cur);
        }
        return; // sent (or server-deduped to the original) — done
      } catch (err) {
        const retryable = (err instanceof AskDispatchError && err.retryable) || (err instanceof ManagedAskError && err.status === 503);
        const msg = err instanceof Error ? err.message : String(err);
        if (retryable && attempt < CARD_DISPATCH_MAX_ATTEMPTS) {
          const backoff = Math.min(CARD_DISPATCH_BACKOFF_MS * attempt, CARD_DISPATCH_BACKOFF_CAP_MS);
          logger.warn?.(
            `ask-broker: ${ask.askId} card dispatch attempt ${attempt} failed (transient): ${msg} — retrying in ${backoff}ms`,
          );
          await sleep(backoff);
          continue;
        }
        // Deterministic failure, exhausted retries, or an untyped throw (fail
        // closed): invalidate so the blocked CLI unblocks instead of hanging.
        logger.warn?.(
          `ask-broker: ${ask.askId} card dispatch failed (${retryable ? 'transient, retries exhausted' : 'not retryable'}): ${msg}`,
        );
        settle(ask.askId, {
          kind: 'invalidated', reason: `card dispatch failed: ${msg}`,
          selected: null, by: null, comment: null, timedOut: false,
        });
        return;
      }
    }
  })();
}

function armAskTimeout(ask: InternalPending, timeoutMs: number, startedAt: number): void {
  clearTimeout(ask.timeoutHandle);
  ask.timeoutStartedAt = startedAt;
  ask.deadlineAt = startedAt + timeoutMs;
  ask.timeoutHandle = setTimeout(() => {
    settle(ask.askId, { kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true });
  }, timeoutMs);
  ask.timeoutHandle.unref?.();
}

/** Promise-based sleep whose timer never keeps the process alive (unref). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const h = setTimeout(resolve, ms);
    h.unref?.();
  });
}

/** Find an entry by its scoped stable key (any state). */
function findByKey(askKey: string): InternalPending | undefined {
  for (const ask of pending.values()) if (ask.askKey === askKey) return ask;
  return undefined;
}

type ManagedPresenter = ReturnType<typeof import('./managed-ask-presentation.js').createManagedAskPresenter>;
let managedPresenter: ManagedPresenter | undefined;
export function setManagedAskPresenter(presenter: ManagedPresenter): void { managedPresenter = presenter; }
export function refreshManagedAskPresentation(key: string): void {
  const ask = findByKey(key); if (ask) publishManagedStatus(ask);
}
function publishManagedStatus(ask: InternalPending): void {
  if (ask.managedRecord && managedPresenter) void managedPresenter.publish(ask.askKey)
    .catch(error => logger.warn(`managed Ask presentation: ${error.message}`));
}

/** Worker generation is checked at the caller; require exact turn/attempt too.
 * No inference from idle, timeout, or text saying that work has completed. */
export function advanceManagedAskPresentation(identity: {
  larkAppId: string; sessionId: string; turnId?: string; dispatchAttempt?: number;
  workerGeneration: number; phase: 'running' | 'execution_completed' | 'unknown' | 'blocked';
  observedAt?: number; blockedReason?: 'rate_limit' | 'stalled';
}): void {
  if (!managedPresenter || !identity.turnId) return;
  for (const ask of pending.values()) {
    if (!ask.managedRecord || ask.larkAppId !== identity.larkAppId || ask.sessionId !== identity.sessionId) continue;
    const saved = managedAskStore().get(ask.askKey);
    if (!saved.found || saved.record.terminalResult?.kind !== 'answered') continue;
    const p = saved.record;
    if (identity.observedAt !== undefined && identity.observedAt < (p.acceptedAt ?? Infinity)) continue;
    const original = !p.continuation?.triggerId && p.originalTurn.turnId === identity.turnId
      && p.originalTurn.dispatchAttempt === identity.dispatchAttempt && p.execution?.workerGeneration === identity.workerGeneration;
    // Continuation triggerId comes only from native fixed-key registration.
    const continuation = p.continuation?.triggerId === identity.turnId;
    if (original || continuation) void managedPresenter.advance(ask.askKey, identity.phase, identity.turnId, identity.blockedReason)
      .catch(error => logger.warn(`managed Ask runtime event: ${error.message}`));
  }
}

/** Only one managed HTTP waiter may own an invocation at a time. A disconnect
 * releases the connection, not the Ask or its execution authority. */
function managedWaiter(ask: InternalPending, signal?: AbortSignal): Promise<AskResult> {
  return new Promise((resolve, reject) => {
    const finish = (result: AskResult) => {
      signal?.removeEventListener('abort', abort);
      const saved = persistStore?.managed?.get(ask.askKey);
      if (!saved?.found || saved.record.continuation) {
        reject(new ManagedAskError('managed_ask_consumption_transferred', 409));
        return;
      }
      resolve(result);
    };
    const abort = () => {
      const index = ask.waiters.indexOf(finish);
      if (index >= 0) ask.waiters.splice(index, 1);
      reject(new ManagedAskError('managed_ask_waiter_disconnected'));
    };
    if (signal?.aborted) { abort(); return; }
    ask.waiters.push(finish);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Restore v3 without claiming a result, dispatching a card, or reopening a terminal. */
function restoreManagedAsk(p: PersistedManagedAsk, now = Date.now()): InternalPending {
  const ask: InternalPending = {
    askId: p.askId, askKey: p.askKey, requestId: p.requestId, originKind: p.originKind,
    nonce: p.nonce, larkAppId: p.larkAppId, sessionId: p.sessionId, chatId: p.chatId,
    rootMessageId: p.rootMessageId, chatType: p.chatType, answererOpenId: p.answererOpenId,
    questions: p.questions, createdAt: p.createdAt, deadlineAt: p.deadlineAt,
    cardMessageId: p.cardMessageId, replyCardTarget: p.replyCardTarget, originalTurn: p.originalTurn,
    managedRecord: p, managedDelivery: p.deliveryContext,
    resumable: false, dormant: true, waiters: [],
    timeoutMs: p.timeoutMs ?? p.deadlineAt - p.createdAt, timeoutStartsAfterDelivery: false,
    settled: p.phase === 'terminal', settledAt: p.acceptedAt,
    terminalResult: p.terminalResult,
    selections: new Map(p.questions.map((_, i) => [i, new Set(p.selections?.[i] ?? [])])),
  };
  pending.set(ask.askId, ask);
  if (!ask.settled) armAskTimeout(ask, Math.max(0, p.deadlineAt - now), now);
  else if (!p.resultExpired) { armManagedExpiry(ask); publishManagedStatus(ask); }
  return ask;
}

export interface AskLookupIdentity {
  larkAppId: string;
  sessionId: string;
  chatId: string;
  rootMessageId: string | null;
  requestId: string;
  originKind: string;
}

/** Internal daemon seam; no HTTP body can supply the store or mutate it. */
export function managedAskStore() {
  if (!persistStore?.managed) throw new ManagedAskError('managed_ask_store_unavailable');
  return persistStore.managed;
}

export function managedAskHasWaiter(key: string): boolean {
  return !!findByKey(key)?.waiters.length;
}

/** Called only after worker/session/generation validation in worker-pool. A
 * missing event or failed disk write stays unknown; idle is never a substitute. */
export function recordManagedAskTerminal(identity: {
  larkAppId: string; sessionId: string; turnId: string; dispatchAttempt?: number;
  workerGeneration: number; bootId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
}): void {
  for (const ask of pending.values()) {
    if (!ask.managedRecord || ask.larkAppId !== identity.larkAppId || ask.sessionId !== identity.sessionId
      || ask.originalTurn?.turnId !== identity.turnId || ask.originalTurn.dispatchAttempt !== identity.dispatchAttempt) continue;
    ask.managedRecord = managedAskStore().update(ask.askKey, p => {
      const e = p.execution;
      if (!e || e.bootId !== identity.bootId || e.workerGeneration !== identity.workerGeneration) return p;
      if (e.terminal && e.terminal.status !== identity.status) throw new ManagedAskError('managed_ask_terminal_conflict', 409);
      return { ...p, execution: { ...e, terminal: e.terminal ?? { status: identity.status, observedAt: Date.now() } } };
    });
  }
}

/** Strictly read-only, including when the session/record is expired or malformed. */
export function lookupManagedAsk(identity: AskLookupIdentity, now = Date.now()) {
  if (!persistStore?.managed) throw new ManagedAskError('managed_ask_store_unavailable');
  const key = askKeyFor(identity.larkAppId, identity.sessionId, identity.originKind, identity.requestId);
  const saved = persistStore.managed.get(key);
  if (!saved.found) return { found: false as const, state: 'unknown' as const, reason: saved.reason };
  const p = saved.record;
  if (p.chatId !== identity.chatId || p.rootMessageId !== identity.rootMessageId) {
    throw new ManagedAskError('managed_ask_identity_conflict', 403);
  }
  if (p.resultExpired || (p.expiresAt ?? Infinity) <= now) {
    return { found: true as const, state: 'unknown' as const, reason: 'result_expired', askKey: key };
  }
  const active = findByKey(key);
  return {
    found: true as const, state: p.phase, askKey: key, requestId: p.requestId, originKind: p.originKind,
    deliveryContext: p.deliveryContext, originalTurn: p.originalTurn,
    execution: p.execution,
    cardMessageId: p.cardMessageId, terminalResult: p.terminalResult,
    acceptedAt: p.acceptedAt, expiresAt: p.expiresAt,
    presentation: p.presentation, continuation: p.continuation,
    ...(p.phase === 'pending' && (p.deadlineAt <= now || active?.pendingSystemResult)
      ? { state: 'unknown' as const, reason: 'terminal_persistence_pending' } : {}),
    // Absence of a live HTTP waiter does NOT prove the original CLI has stopped.
    waiter: active && active.waiters.length > 0 ? 'attached' as const : 'unknown' as const,
  };
}

/**
 * Re-attach a reconnecting hook to a restored DORMANT ask. Two cases:
 *  - answer already stashed (click → reattach): deliver the durable-handoff
 *    result immediately, settle, remove the persisted record. No new card/timer.
 *  - still awaiting a click: install a waiter + timeout re-armed to the ORIGINAL
 *    absolute deadline; re-send the card if it was never confirmed sent.
 */
function reattachByRequest(ask: InternalPending): Promise<AskResult> {
  if (ask.answeredResult) {
    const result = ask.answeredResult;
    ask.dormant = false;
    ask.settled = true;
    ask.settledAt = Date.now();
    ask.terminalResult = result;
    clearTimeout(ask.timeoutHandle);
    clearTimeout(ask.handoffExpiryHandle);
    clearTimeout(ask.persistenceRetryHandle); // claimed → cancel the unclaimed-stash reaper
    persistStore?.remove(ask.askKey); // claimed → durable record no longer needed
    gcSettled();
    logger.info?.(`ask-broker: re-attach delivered stashed answer for ask ${ask.askId} (key=${ask.askKey})`);
    return Promise.resolve(result);
  }

  return new Promise<AskResult>((resolve) => {
    ask.dormant = false;
    ask.waiters.push(resolve);
    clearTimeout(ask.timeoutHandle);
    const awaitsDelivery = ask.timeoutStartsAfterDelivery && !ask.cardMessageId;
    const remaining = awaitsDelivery ? ask.timeoutMs : Math.max(0, ask.deadlineAt - Date.now());
    if (!awaitsDelivery) armAskTimeout(ask, remaining, Date.now());
    logger.info?.(
      `ask-broker: re-attached hook to restored ask ${ask.askId} (key=${ask.askKey}, ` +
      `${Math.round(remaining / 1000)}s left, card=${ask.cardMessageId ? 'live' : 'MISSING→resend'})`,
    );
    if (!ask.cardMessageId) sendCardForAsk(ask);
  });
}

/** Build the persisted projection from a live internal ask and write it. Only
 *  called for resumable asks. */
function persistFromInternal(ask: InternalPending): void {
  if (ask.managedRecord) {
    const next = { ...ask.managedRecord, cardMessageId: ask.cardMessageId,
      selections: ask.questions.map((_, i) => [...(ask.selections.get(i) ?? [])]) };
    persistStore!.managed!.put(next);
    ask.managedRecord = next;
    return;
  }
  if (!persistStore || !ask.resumable) return;
  // A settled ask with a stashed answer is a durable handoff that must be KEPT
  // until claimed; a settled ask without one has nothing left to resume.
  if (ask.settled && !ask.answeredResult) return;
  const persisted: PersistedAsk = {
    v: 2,
    askKey: ask.askKey,
    requestId: ask.requestId,
    originKind: ask.originKind,
    askId: ask.askId,
    nonce: ask.nonce,
    larkAppId: ask.larkAppId,
    chatId: ask.chatId,
    rootMessageId: ask.rootMessageId,
    sessionId: ask.sessionId,
    chatType: ask.chatType,
    answererOpenId: ask.answererOpenId,
    questions: ask.questions,
    createdAt: ask.createdAt,
    deadlineAt: ask.deadlineAt,
    timeoutMs: ask.timeoutMs,
    timeoutStartsAfterDelivery: ask.timeoutStartsAfterDelivery,
    timeoutStartedAt: ask.timeoutStartedAt,
    cardMessageId: ask.cardMessageId,
    replyCardTarget: ask.replyCardTarget,
    selections: ask.questions.map((_, i) => [...(ask.selections.get(i) ?? new Set<string>())]),
    ...(ask.answeredResult ? { answeredResult: ask.answeredResult, answeredAt: ask.settledAt ?? Date.now() } : {}),
  };
  persistStore.put(persisted);
}

/**
 * 勾选/取消勾选某问题的某个选项（累积模式，不 settle）。
 *
 * 校验同 `tryResolveAsk`：askId 存在 / nonce 匹配 / 未 settle / 已授权 /
 * questionIndex 合法 / key 在该问题的 options 中。
 *
 * 对于单选问题（multiSelect:false），翻转时 Set 内只保留该 key（相当于"换选"）。
 * 对于多选问题（multiSelect:true），翻转规则：已在 Set 中则移除，否则添加。
 *
 * 成功返回 `'toggled'`；非法返回对应 AskClickOutcome。
 */
export function toggleAsk(args: {
  askId: string;
  nonce: string;
  questionIndex: number;
  key: string;
  by: string;
}): AskClickOutcome {
  gcSettled();
  const ask = pending.get(args.askId);
  if (!ask) return 'stale';
  if (ask.nonce !== args.nonce) return 'stale';
  if (ask.settled) return 'already_settled';
  if (!isAuthorizedToAnswer(ask, args.by)) return 'unauthorized';

  const question = ask.questions[args.questionIndex];
  if (!question) return 'stale';
  if (!question.options.some((o) => o.key === args.key)) return 'stale';

  const sel = ask.selections.get(args.questionIndex)!;
  const previousSelection = new Set(sel);

  if (question.multiSelect) {
    // 多选：有则删、无则加
    if (sel.has(args.key)) {
      sel.delete(args.key);
    } else {
      sel.add(args.key);
    }
  } else {
    // 单选：清空后只保留该 key（等价于"换选"，再次 toggle 同一 key 也保留）
    sel.clear();
    sel.add(args.key);
  }

  // Persist the updated checkbox state so a restart mid-multi-select keeps the
  // boxes the user already ticked (best-effort; never blocks the toggle).
  try { persistFromInternal(ask); }
  catch {
    ask.selections.set(args.questionIndex, previousSelection);
    return 'persistence_failed';
  }

  return 'toggled';
}

/**
 * 提交答案并 settle。
 *
 * `selections` 显式传入时直接使用（按钮单选 / 一次性表单提交场景）；
 * 否则使用 `toggleAsk` 累积的勾选状态。
 *
 * 对于 `multiSelect:false` 的问题，要求恰好 1 个选中，否则返回 `'stale'`。
 * 校验通过则 settle 并返回 `'accepted'`；非法返回对应 AskClickOutcome。
 */
export function submitAsk(args: {
  askId: string;
  nonce: string;
  by: string;
  selections?: ReadonlyArray<ReadonlyArray<string>>;
  /** 空提交二次确认已通过（用户在 arm 卡片上再点了一次）。仅影响「全多选 + 全空」
   *  这一种可确认的空提交；其它情形不看它。缺省 false。 */
  confirmEmpty?: boolean;
}): AskClickOutcome {
  gcSettled();
  const ask = pending.get(args.askId);
  if (!ask) return 'stale';
  if (ask.nonce !== args.nonce) return 'stale';
  if (ask.settled) return 'already_settled';
  if (!isAuthorizedToAnswer(ask, args.by)) return 'unauthorized';

  // 构建最终答案数组（严格按 ask.questions 规范化，长度恒 = questions.length）
  let answers: ReadonlyArray<ReadonlyArray<string>>;

  if (args.selections !== undefined) {
    // 显式传入：拒绝超出真实问题数的输入（form_value 是外部输入，未绑定真实 question
    // 的额外槽既不能影响确认策略、也不能进入结果）；缺失的尾部按空集补齐（兼容旧 form
    // 只回传前 N 问的情形）。随后逐问按 canonical 槽校验单选约束 + key 合法性。
    if (args.selections.length > ask.questions.length) return 'stale';
    const canonical: string[][] = [];
    for (let i = 0; i < ask.questions.length; i++) {
      const q = ask.questions[i]!;
      const sel = args.selections[i] ?? [];
      if (!q.multiSelect && sel.length !== 1) return 'stale';
      for (const key of sel) {
        if (!q.options.some((o) => o.key === key)) return 'stale';
      }
      canonical.push([...sel]);
    }
    answers = canonical;
  } else {
    // 使用累积的勾选状态
    const built: string[][] = [];
    for (let i = 0; i < ask.questions.length; i++) {
      const q = ask.questions[i]!;
      const sel = ask.selections.get(i)!;
      if (!q.multiSelect && sel.size !== 1) return 'stale';
      built.push([...sel]);
    }
    answers = built;
  }

  // 空提交二次确认（防手滑）：鉴权 + nonce + 单选约束都过了，若「每个问题都允许空集
  // （全多选）」且当前所有问题都没选任何 key，第一次提交先不 settle，返回
  // needs_empty_confirm 让卡片 arm 一个确认按钮；带 confirmEmpty 再点才真正落空答案。
  // 只在全多选时触发：只要有一个单选问题，空集在上面的单选约束里已被判 stale，空提交
  // 本就不是有效答案，不进二次确认（否则 arm 后二次点击必然 stale，形成死路）。
  // answers 已按 questions 规范化（长度恒等、无越界槽），故 every() 只看真实问题。
  if (!args.confirmEmpty
      && ask.questions.length > 0
      && ask.questions.every((q) => q.multiSelect)
      && answers.every((keys) => keys.length === 0)) {
    return 'needs_empty_confirm';
  }

  const accepted = settle(args.askId, {
    kind: 'answered',
    answers,
    by: args.by,
    comment: null,
    timedOut: false,
  });
  return accepted ? 'accepted' : 'persistence_failed';
}

/**
 * 提交一段自定义回复（用户在话题里直接打字作答，替代点按钮）并 settle。
 *
 * 校验：askId 存在 / 未 settle / `by` 可 canTalk / text trim 后非空。
 * settle 为 `kind:'answered'`，各问 `answers` 为空数组、`comment` 携带 trim 后原文
 * （替代语义：没有任何选项被选中，CLI 侧 formatAnswer 用 comment 回落作答）。
 *
 * 不需要 nonce：调用方（daemon 消息路由）用 `findPendingAskByAnchor` 从在线
 * pending 表按话题 anchor 查到 askId，本身就排除了「重启后的陈旧卡片」场景。
 *
 * `actor`：文字作答路径拿得到完整消息事件，把 bot / union context 传进来，让 talk
 * 判定与 dispatcher 外层闸 / quota 复查同源（bot → evaluateBotTalk，人 → evaluateTalk
 * 的 teamMember union 腿）。不传则退化为纯 open_id 判定（与卡片点击一致）。
 *
 * 成功返回 `'accepted'`；非法返回对应 AskClickOutcome。
 */
export function submitCustomReply(args: {
  askId: string;
  by: string;
  text: string;
  actor?: AskAnswerActor;
}): AskClickOutcome {
  gcSettled();
  const ask = pending.get(args.askId);
  if (!ask) return 'stale';
  if (ask.settled) return 'already_settled';
  if (!isAuthorizedToAnswer(ask, args.by, args.actor)) return 'unauthorized';
  const text = args.text.trim();
  if (!text) return 'stale';

  const accepted = settle(args.askId, {
    kind: 'answered',
    answers: ask.questions.map(() => []),
    by: args.by,
    comment: text,
    timedOut: false,
  });
  return accepted ? 'accepted' : 'persistence_failed';
}

/**
 * 按话题 anchor 查找一个**未 settle**的 pending ask，供 daemon 判断「这条文字回复
 * 是不是在回答某个 ask」。匹配条件：
 *   - larkAppId 相同（不跨 bot 命中）
 *   - chatId 相同
 *   - thread-scope：ask.rootMessageId === anchor（话题根 message_id）
 *   - chat-scope：ask.rootMessageId === null（anchor 实为 chatId，已由 chatId 命中）
 *
 * 命中多个时返回最先注册的（实践中同一 anchor 同时最多一个 pending ask，因为发起
 * ask 的 CLI 此刻正阻塞等待结果）。返回 snapshot，改它不影响 broker 状态。
 */
export function findPendingAskByAnchor(args: {
  larkAppId: string;
  chatId: string;
  anchor: string;
}): PendingAsk | undefined {
  for (const ask of pending.values()) {
    if (ask.settled) continue;
    if (ask.larkAppId !== args.larkAppId) continue;
    if (ask.chatId !== args.chatId) continue;
    const matches =
      ask.rootMessageId === null ? true : ask.rootMessageId === args.anchor;
    if (matches) return snapshot(ask);
  }
  return undefined;
}

/** Resolve attempt from a card-button click. Returns one of the §10 outcomes;
 *  caller (card click handler) maps to user-facing toast.
 *
 *  v0.1.8 起退化为单问单选的便捷封装：等价于
 *  `submitAsk({..., selections:[[selected]]})`.
 *  使 `botmux ask buttons` 与其已有测试零回归。
 *
 *  All four "no-op" outcomes (`unauthorized`/`stale`/`already_settled`) leave
 *  the broker state unchanged so the original CLI Promise keeps waiting for
 *  the real winner or the deadline. */
export function tryResolveAsk(args: {
  askId: string;
  nonce: string;
  selected: string;
  by: string;
}): AskClickOutcome {
  return submitAsk({
    askId: args.askId,
    nonce: args.nonce,
    by: args.by,
    selections: [[args.selected]],
  });
}

export function invalidateReplyCardAsks(target: { larkAppId: string; sessionId: string; turnId: string; dispatchAttempt?: number }, reason: string): void {
  for (const ask of pending.values()) {
    if (ask.larkAppId === target.larkAppId && ask.sessionId === target.sessionId
      && ask.replyCardTarget?.turnId === target.turnId && ask.replyCardTarget.dispatchAttempt === target.dispatchAttempt) {
      settle(ask.askId, { kind: 'invalidated', reason, selected: null, by: null, comment: null, timedOut: false });
    }
  }
}

/** Invalidate every pending ask. Intended for daemon shutdown / restart paths
 *  so CLI subprocesses unblock with `kind:'invalidated'` instead of waiting
 *  forever on a dead daemon. Returns the number of asks actually settled
 *  (settled-but-retained entries from the race window are skipped). */
export function invalidateAll(reason: string): number {
  const ids = [...pending.entries()]
    .filter(([, ask]) => !ask.settled)
    .map(([id]) => id);
  for (const id of ids) {
    settle(id, {
      kind: 'invalidated',
      reason,
      selected: null,
      by: null,
      comment: null,
      timedOut: false,
    });
  }
  if (ids.length > 0) {
    logger.info?.(`ask-broker: invalidated ${ids.length} pending ask(s): ${reason}`);
  }
  return ids.length;
}

/**
 * Restore pending asks from disk after a daemon restart. Each becomes a DORMANT
 * entry: its card is still live in Feishu (we do NOT re-post — cardMessageId is
 * preserved), so a click can settle it, but there is no waiter Promise until the
 * surviving CLI hook reconnects and re-registers (findDormantByKey →
 * reattachDormantAsk installs a fresh resolve). Each dormant ask arms a timer to
 * its ORIGINAL absolute deadline so it can't linger forever if the CLI never
 * comes back. Called once during daemon bootstrap. Returns the count restored.
 *
 * Idempotent-ish: an askKey already present (e.g. re-invoked) is skipped.
 */
export function restorePersistedAsks(now: number = Date.now(), larkAppId?: string): number {
  let restored = 0;
  if (!persistStore) {
    logger.info?.('ask-broker: restore sweep skipped — no persist store wired');
    return 0;
  }
  for (const p of persistStore.managed?.list(now, larkAppId) ?? []) {
    if (larkAppId && p.larkAppId !== larkAppId) continue;
    if (!findByKey(p.askKey)) { restoreManagedAsk(p, now); restored++; }
  }
  for (const p of persistStore.list(now)) {
    // One bot per daemon process: only restore asks this daemon can actually
    // serve (its own bot's sessions). Another bot's daemon owns the rest.
    if (larkAppId && p.larkAppId !== larkAppId) continue;
    // Skip if this key is already live (defensive — boot runs once).
    let dup = false;
    for (const a of pending.values()) if (a.askKey === p.askKey && !a.settled) { dup = true; break; }
    if (dup) continue;

    const selections = new Map<number, Set<string>>();
    for (let i = 0; i < p.questions.length; i++) {
      selections.set(i, new Set<string>(p.selections?.[i] ?? []));
    }
    const hasStashedAnswer = p.answeredResult !== undefined;
    // A stashed-answer restore is already terminal (settled), awaiting only the
    // hook's claim — it must NOT arm a deadline timer (there's nothing left to
    // time out). A still-awaiting-click restore arms the ORIGINAL absolute
    // deadline so it can't linger forever if the CLI never returns.
    const awaitsDelivery = p.timeoutStartsAfterDelivery === true && !p.cardMessageId;
    const remaining = awaitsDelivery
      ? (p.timeoutMs ?? Math.max(1, p.deadlineAt - p.createdAt))
      : Math.max(0, p.deadlineAt - now);
    const timeoutHandle = hasStashedAnswer || awaitsDelivery
      ? undefined
      : setTimeout(() => {
          settle(p.askId, {
            kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true,
          });
        }, remaining);
    timeoutHandle?.unref?.();

    const ask: InternalPending = {
      askId: p.askId,
      askKey: p.askKey,
      requestId: p.requestId,
      originKind: p.originKind,
      resumable: true, // only resumable origins were ever persisted
      nonce: p.nonce,
      larkAppId: p.larkAppId,
      chatId: p.chatId,
      rootMessageId: p.rootMessageId,
      sessionId: p.sessionId,
      chatType: p.chatType,
      answererOpenId: p.answererOpenId,
      questions: p.questions,
      createdAt: p.createdAt,
      deadlineAt: p.deadlineAt,
      timeoutMs: p.timeoutMs ?? Math.max(1, p.deadlineAt - p.createdAt),
      timeoutStartsAfterDelivery: p.timeoutStartsAfterDelivery === true,
      timeoutStartedAt: p.timeoutStartedAt,
      cardMessageId: p.cardMessageId,
      replyCardTarget: p.replyCardTarget,
      // A stashed-answer restore is terminal-but-unclaimed: settled=true so
      // gcSettled/other paths treat it as done, dormant=true so a hook re-POST
      // routes to reattachByRequest to CLAIM it.
      settled: hasStashedAnswer,
      settledAt: hasStashedAnswer ? (p.answeredAt ?? now) : undefined,
      dormant: true,
      waiters: [], // attached when the reconnecting hook re-registers
      // Carry a stashed answer forward (user answered before restart): the
      // reconnecting hook claims it via reattachByRequest.
      ...(p.answeredResult ? { answeredResult: p.answeredResult, terminalResult: p.answeredResult } : {}),
      // timeoutHandle is only meaningful for the awaiting-click case; a stashed
      // restore uses a no-op cleared handle so clearTimeout calls stay safe.
      timeoutHandle: timeoutHandle ?? setTimeout(() => {}, 0),
      selections,
    };
    if (timeoutHandle === undefined) { clearTimeout(ask.timeoutHandle); }
    pending.set(p.askId, ask);
    // Re-arm the absolute handoff-expiry reaper for a restored stash (codex
    // P1-4): a SECOND restart before the hook claims must still reap memory +
    // disk at the ORIGINAL answeredAt + retention, not restart the clock.
    if (hasStashedAnswer) armHandoffExpiry(ask);
    restored++;
    logger.info?.(
      `ask-broker: restored pending ask ${p.askId} (key=${p.askKey}, session=${p.sessionId}, ` +
      `dormant${p.answeredResult ? '+answered' : ''}, ${Math.round((p.deadlineAt - now) / 1000)}s left) — awaiting hook re-attach`,
    );
  }
  // Always log the boot sweep outcome (even 0) so a live restart test can
  // confirm the restore path ran, not just infer it from behaviour.
  logger.info?.(
    `ask-broker: restore sweep complete — ${restored} pending ask(s) restored` +
    (larkAppId ? ` for ${larkAppId}` : ''),
  );
  return restored;
}

function armManagedExpiry(ask: InternalPending, retries = 0): void {
  clearTimeout(ask.managedExpiryHandle);
  const expiresAt = ask.managedRecord?.expiresAt;
  if (expiresAt === undefined || ask.managedRecord?.resultExpired) return;
  const wait = retries ? 30000 : Math.max(0, expiresAt - Date.now());
  ask.managedExpiryHandle = setTimeout(() => {
    if (pending.get(ask.askId) !== ask) return;
    try {
      const record = persistStore?.managed?.expire(ask.askKey);
      if (record?.resultExpired) {
        ask.managedRecord = record;
        ask.terminalResult = undefined;
        ask.selections = new Map(ask.questions.map((_, i) => [i, new Set<string>()]));
        gcSettled();
      }
    } catch (error) {
      logger.warn(`ask-broker: answer expiry failed for ${ask.askId}: ${(error as Error).message}`);
      if (retries < 10) armManagedExpiry(ask, retries + 1);
    }
  }, wait);
  ask.managedExpiryHandle.unref?.();
}

/** Internal — settle an ask exactly once and notify the dispatcher's onSettle
 *  hook (best-effort, never blocks broker state transitions). The settled
 *  entry stays in the map for `SETTLED_RETENTION_MS` so late race-losers get
 *  a precise `already_settled` outcome; `gcSettled` reaps it afterward. */
function settle(askId: string, result: AskResult): boolean {
  const ask = pending.get(askId);
  if (!ask || ask.settled) return false;

  if (ask.managedRecord) {
    const acceptedAt = Date.now();
    let next: PersistedManagedAsk = { ...ask.managedRecord,
      cardMessageId: ask.cardMessageId, phase: 'terminal', terminalResult: result,
      acceptedAt, expiresAt: acceptedAt + HANDOFF_RETENTION_MS,
      presentation: { ...ask.managedRecord.presentation, state: result.kind === 'answered' ? 'pending' : 'none', revision: 1, phase: 'accepted' },
    };
    if (result.kind !== 'answered') ask.pendingSystemResult = result;
    if (result.kind === 'answered' && (ask.pendingSystemResult || ask.deadlineAt <= acceptedAt)) return false;
    try {
      const saved = persistStore!.managed!.get(ask.askKey);
      if (saved.found && saved.record.phase === 'terminal') {
        // A previous rename may have landed before an fsync/response error.
        // Never overwrite its result or extend its retention on retry.
        if (JSON.stringify(saved.record.terminalResult) !== JSON.stringify(result)) {
          throw new ManagedAskError('managed_ask_terminal_conflict', 409);
        }
        next = { ...saved.record, cardMessageId: ask.cardMessageId ?? saved.record.cardMessageId };
      }
      persistStore!.managed!.put(next);
    }
    catch (e) {
      logger.warn(`ask-broker: durable acceptance failed for ${askId}: ${e instanceof Error ? e.message : String(e)}`);
      // No answer is acknowledged on failure. Timeout/cancel has no human retry,
      // so retry the SAME result with a bounded timer; never create another Ask.
      if (result.kind !== 'answered' && !ask.persistenceRetryHandle && (ask.persistenceRetryCount ?? 0) < 60) {
        ask.persistenceRetryCount = (ask.persistenceRetryCount ?? 0) + 1;
        ask.persistenceRetryHandle = setTimeout(() => {
          ask.persistenceRetryHandle = undefined;
          settle(askId, result);
        }, 5000);
        ask.persistenceRetryHandle.unref?.();
      }
      return false;
    }
    ask.managedRecord = next;
    ask.settled = true;
    ask.settledAt = next.acceptedAt;
    ask.terminalResult = result;
    clearTimeout(ask.timeoutHandle);
    clearTimeout(ask.persistenceRetryHandle);
    const waiters = ask.waiters.splice(0);
    // Release is synchronous after commit. Presentation cannot hold the answer hostage.
    for (const waiter of waiters) waiter(result);
    armManagedExpiry(ask);
    notifyOnSettle(ask, result);
    return true;
  }

  // Durable handoff (codex P1-1): a dormant ask (restored after a restart, no
  // waiter yet) that receives an ANSWER must NOT drop it into the void. Stash
  // the terminal result and KEEP the persisted record so the reconnecting hook
  // can claim it (reattachDormantAsk delivers + removes). Only answered results
  // are worth stashing — a dormant ask that timed out / was invalidated has no
  // consumer to hand off to, so it settles+cleans normally.
  if (ask.dormant && ask.waiters.length === 0 && result.kind === 'answered') {
    ask.settled = true;
    ask.settledAt = Date.now();
    ask.answeredResult = result;
    ask.terminalResult = result;
    clearTimeout(ask.timeoutHandle);
    persistFromInternal(ask); // re-persist WITH answeredResult + answeredAt (kept until claimed)
    // Arm the absolute handoff-expiry timer (codex P1-4): if the reconnecting
    // hook never claims this stash (CLI gone for good), reap memory + disk
    // TOGETHER at answeredAt + HANDOFF_RETENTION_MS — not just on the next boot
    // list() sweep, which a long-running daemon never performs.
    armHandoffExpiry(ask);
    logger.info?.(`ask-broker: stashed answer for dormant ask ${askId} (key=${ask.askKey}) — awaiting hook claim`);
    // Still notify the card layer so the Feishu card flips to its settled view.
    notifyOnSettle(ask, result);
    return true;
  }

  ask.settled = true;
  ask.settledAt = Date.now();
  ask.terminalResult = result; // retained for a same-requestId replay in the ambiguous window
  clearTimeout(ask.timeoutHandle);
  // The durable record's job is done the moment the ask leaves the pending
  // state (delivered to live waiters, or a terminal non-answer) — drop it so a
  // later restart doesn't resurrect a settled ask.
  persistStore?.remove(ask.askKey);
  // Reap older settled entries opportunistically — keeps the map bounded
  // without paying for a dedicated GC timer.
  gcSettled();

  // Resolve every waiter (normally one; >1 when a same-requestId active replay
  // joined). A dormant ask has no waiters — the loop simply no-ops.
  const waiters = ask.waiters;
  ask.waiters = [];
  for (const w of waiters) {
    try {
      w(result);
    } catch (err) {
      logger.warn?.(
        `ask-broker: ${askId} waiter threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  notifyOnSettle(ask, result);
  return true;
}

/** Notify the IM-side dispatcher's onSettle hook (best-effort — never blocks
 *  broker state). Shared by the normal settle path and the dormant-answer stash. */
function notifyOnSettle(ask: InternalPending, result: AskResult): void {
  publishManagedStatus(ask);
  if (!dispatcher?.onSettle) return;
  try {
    void Promise.resolve(dispatcher.onSettle(snapshot(ask), result)).catch((err) => {
      logger.warn?.(
        `ask-broker: ${ask.askId} onSettle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  } catch (err) {
    logger.warn?.(
      `ask-broker: ${ask.askId} onSettle threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Strip broker-internal fields before handing a snapshot to the IM-side
 *  dispatcher. Keeps the dispatcher contract narrow (PendingAsk only). */
function snapshot(ask: InternalPending): PendingAsk {
  const {
    // Runtime-only / broker-internal fields excluded from the IM contract:
    waiters: _w, timeoutHandle: _t, settledAt: _sat, selections: _sel,
    handoffExpiryHandle: _he, managedRecord: _mr, persistenceRetryHandle: _pr,
    persistenceRetryCount: _pc, pendingSystemResult: _ps, managedExpiryHandle: _me,
    timeoutMs: _tm, timeoutStartsAfterDelivery: _td, timeoutStartedAt: _ts,
    askKey: _ak, requestId: _rid, resumable: _rs,
    dormant: _dm, answeredResult: _ar, terminalResult: _tr,
    ...rest
  } = ask;
  return {
    ...rest,
    ...(ask.terminalResult ? { result: ask.terminalResult } : {}),
    selections: ask.questions.map((_, i) => [...(ask.selections.get(i) ?? new Set<string>())]),
    // EVERY ask carries a scoped dedupe token (codex P1-1): the broker's bounded
    // retry re-sends the card, and a re-send without a uuid posts a DUPLICATE on
    // the Feishu side. The uuid is the card's dedupe identity for THIS broker
    // lifetime — derived from the scoped askKey, independent of persistence.
    // `resumable` gates only cross-restart persistence, NOT intra-process
    // dispatch idempotency, so explicit / PTY asks (which also retry) dedupe too.
    dispatchUuid: dispatchUuidForKey(ask.askKey),
  };
}

/** Drop settled entries that have aged past the retention window. Cheap O(n)
 *  walk — n is tiny in practice (≤ a few dozen pending+recent asks). A dormant
 *  ask holding a stashed answer (durable handoff, awaiting the hook's claim) is
 *  NEVER reaped from memory here — it lives until claimed or its deadline; on
 *  disk it survives regardless, and a restart re-hydrates it. */
function gcSettled(): void {
  const cutoff = Date.now() - SETTLED_RETENTION_MS;
  for (const [id, ask] of pending) {
    if (ask.managedRecord && !ask.managedRecord.resultExpired) continue;
    if (ask.dormant && ask.answeredResult) continue; // unclaimed handoff — keep
    if (ask.settled && ask.settledAt !== undefined && ask.settledAt < cutoff) {
      pending.delete(id);
    }
  }
}

/**
 * Arm an absolute-expiry timer for an unclaimed handoff stash (codex P1-4). A
 * stashed answer is kept until the reconnecting hook claims it — but if the CLI
 * is gone for good, nothing would ever remove it from a long-running daemon's
 * memory (gcSettled deliberately skips unclaimed handoffs) OR from disk (the
 * disk reap only runs in list() at boot). This timer closes both: at
 * `answeredAt + HANDOFF_RETENTION_MS` it deletes the in-memory entry AND the
 * persisted record TOGETHER, so memory and disk never diverge.
 *
 * Idempotent: clears any prior handle first (re-arming on a second restore is
 * fine). The timer is unref'd so it never keeps the process alive.
 */
function armHandoffExpiry(ask: InternalPending): void {
  clearTimeout(ask.handoffExpiryHandle);
  const stashedAt = ask.settledAt ?? Date.now();
  const fireIn = Math.max(0, stashedAt + handoffRetentionMs - Date.now());
  ask.handoffExpiryHandle = setTimeout(() => {
    // Only reap if STILL an unclaimed stash (a claim clears this handle, but
    // guard against a late fire racing a claim).
    const cur = pending.get(ask.askId);
    if (!cur || !cur.dormant || !cur.answeredResult) return;
    pending.delete(cur.askId);
    persistStore?.remove(cur.askKey);
    logger.info?.(
      `ask-broker: handoff stash expired unclaimed for ask ${cur.askId} (key=${cur.askKey}) — reaped memory + disk`,
    );
  }, fireIn);
  ask.handoffExpiryHandle.unref?.();
}

// ---- diagnostics for tests ---------------------------------------------------

/** Count of asks still awaiting a click / timeout — excludes settled entries
 *  retained within the race-loser feedback window. For tests and metrics only. */
export function _pendingCount(): number {
  let n = 0;
  for (const ask of pending.values()) if (!ask.settled) n++;
  return n;
}

/** Read a pending ask by id. Returns a snapshot; mutating it has no effect on
 *  broker state. Used by the card handler to PATCH toggle state. */
export function getAskSnapshot(askId: string): PendingAsk | undefined {
  const a = pending.get(askId);
  return a ? snapshot(a) : undefined;
}

/** List unsettled asks for Desktop / dashboard aggregation (read-only snapshots). */
export function listPendingAsks(): PendingAsk[] {
  gcSettled();
  const out: PendingAsk[] = [];
  for (const ask of pending.values()) {
    if (!ask.settled) out.push(snapshot(ask));
  }
  return out;
}

/**
 * Desktop / trusted-host answer path. Bypasses canTalk (no Feishu openId) —
 * caller must be authenticated as the local dashboard/desktop operator.
 */
export function submitAskFromDesktop(args: {
  askId: string;
  /** Selected option keys per question (same shape as submitAsk selections). */
  selections: ReadonlyArray<ReadonlyArray<string>>;
  by?: string;
}): AskClickOutcome {
  gcSettled();
  const ask = pending.get(args.askId);
  if (!ask) return 'stale';
  if (ask.settled) return 'already_settled';

  // 同 submitAsk：按 ask.questions 规范化，拒绝超长输入、缺失尾部补空集，越界槽不进结果。
  if (args.selections.length > ask.questions.length) return 'stale';
  const canonical: string[][] = [];
  for (let i = 0; i < ask.questions.length; i++) {
    const q = ask.questions[i]!;
    const sel = args.selections[i] ?? [];
    if (!q.multiSelect && sel.length !== 1) return 'stale';
    for (const key of sel) {
      if (!q.options.some((o) => o.key === key)) return 'stale';
    }
    canonical.push([...sel]);
  }
  const answers = canonical;

  const accepted = settle(args.askId, {
    kind: 'answered',
    answers,
    by: args.by ?? 'desktop',
    comment: null,
    timedOut: false,
  });
  return accepted ? 'accepted' : 'persistence_failed';
}

/** Read a pending ask by id — for tests only. Returns a snapshot; mutating it
 *  has no effect on broker state. */
export function _getPending(askId: string): PendingAsk | undefined {
  return getAskSnapshot(askId);
}

/** 返回当前 pending map 中所有 askId 列表（含 settled 但仍在 retention 内的条目）。
 *  仅供测试使用。 */
export function _allAskIds(): string[] {
  return [...pending.keys()];
}

/** Reset broker state — for tests only. Does NOT resolve outstanding promises,
 *  so tests must not call this while real CLI processes might be waiting. */
export function _resetForTest(): void {
  for (const ask of pending.values()) {
    clearTimeout(ask.timeoutHandle);
    clearTimeout(ask.handoffExpiryHandle);
    clearTimeout(ask.persistenceRetryHandle);
    clearTimeout(ask.managedExpiryHandle);
  }
  pending.clear();
  dispatcher = null;
  managedPresenter = undefined;
  canTalkChecker = null;
  handoffRetentionMs = HANDOFF_RETENTION_MS; // restore default retention
  // Detach the injected store — never delete files here (codex P1-4: a helper
  // reaping a shared dataDir could wipe a LIVE pending ask). Tests own their
  // temp dir's cleanup via their own teardown.
  persistStore = null;
}
