import { refreshManagedAskPresentation } from './ask-broker.js';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import type { PersistedAsyncTriggerResult } from '../services/async-trigger-store.js';
import { askKeyFor } from './ask-persist-store.js';
import { managedAskStore, managedAskHasWaiter, type AskLookupIdentity } from './ask-broker.js';
import { ManagedAskError } from './managed-ask-types.js';
import type { PersistedManagedAsk } from './managed-ask-store.js';

/** Supplied by an owner-installed domain adapter, never by an HTTP caller.
 * It must synchronously read authoritative scope/cancellation/receipt sources.
 * A completed professional result permits collection only. */
export type ManagedAskPolicy = (input: {
  ask: Readonly<PersistedManagedAsk>;
  originalResult?: Readonly<PersistedAsyncTriggerResult>;
  dataDir: string;
}) => { state: 'blocked' | 'completed' | 'invalid' | 'unknown'; reason: string;
  ownerOpenId?: string; resultRef?: string };

export interface ManagedAskContinuationDeps {
  dataDir: string;
  policy?: ManagedAskPolicy;
  originalActive: (ask: PersistedManagedAsk) => boolean;
  answerAuthorized: (ask: PersistedManagedAsk) => boolean;
  readOriginalResult: (ask: PersistedManagedAsk) => { ownerLarkAppId?: string; result: PersistedAsyncTriggerResult } | undefined;
  lookupRegistered: (request: TriggerRequest) => { triggerId: string } | undefined;
  register: (request: TriggerRequest, assertInputCurrent: () => void) => Promise<TriggerResponse>;
}

const inFlight = new Set<string>();
function assertIdentity(p: PersistedManagedAsk, identity: AskLookupIdentity) {
  if (p.larkAppId !== identity.larkAppId || p.sessionId !== identity.sessionId
    || p.chatId !== identity.chatId || p.rootMessageId !== identity.rootMessageId) {
    throw new ManagedAskError('managed_ask_identity_conflict', 403);
  }
}

function inspect(p: PersistedManagedAsk, deps: ManagedAskContinuationDeps) {
  if (p.phase !== 'terminal' || p.terminalResult?.kind !== 'answered' || p.resultExpired
    || (p.expiresAt ?? 0) <= Date.now()) throw new ManagedAskError('managed_ask_answer_unavailable', 409);
  if (!deps.answerAuthorized(p)) throw new ManagedAskError('managed_ask_answer_not_authorized', 403);
  if (managedAskHasWaiter(p.askKey) || deps.originalActive(p)) throw new ManagedAskError('managed_ask_original_execution_active', 409);
  if (!p.execution || p.execution.superseded || p.execution.terminal?.status !== 'completed') {
    throw new ManagedAskError('managed_ask_original_execution_unproven', 409);
  }
  if (!deps.policy) throw new ManagedAskError('managed_ask_policy_unavailable');
  const original = deps.readOriginalResult(p);
  if (!original || original.ownerLarkAppId !== p.larkAppId || original.result.status !== 'completed') {
    throw new ManagedAskError('managed_ask_original_result_unproven', 409);
  }
  const proof = deps.policy({ ask: structuredClone(p), originalResult: structuredClone(original.result), dataDir: deps.dataDir });
  if (proof.ownerOpenId !== p.terminalResult.by) throw new ManagedAskError('managed_ask_owner_mismatch', 403);
  if (proof.state !== 'completed' && proof.state !== 'blocked') {
    throw new ManagedAskError(proof.state === 'invalid' ? 'managed_ask_scope_invalid' : 'managed_ask_business_result_unknown', 409);
  }
  if (!proof.resultRef) throw new ManagedAskError('managed_ask_result_reference_missing', 409);
  return proof;
}

function buildRequest(p: PersistedManagedAsk, resultRef: string): TriggerRequest {
  const key = `${p.requestId}:answered-continuation`;
  return {
    source: { type: 'ui', connectorId: `${p.deliveryContext.domain}-user-decision`, requestId: key,
      receivedAt: new Date(p.acceptedAt!).toISOString() },
    target: { kind: 'turn', botId: p.larkAppId, sessionId: p.sessionId },
    envelope: { format: 'managed-ask-continuation.v1', sourceName: p.deliveryContext.title, trusted: false,
      payload: { deliveryContext: p.deliveryContext, sourceAsk: { requestId: p.requestId, originKind: p.originKind },
        question: p.questions, answer: p.terminalResult, resultRef } },
    instruction: 'Read the exact original question, answer and professional result reference. Recheck the current Project/Issue scope and cancellation before acting. An answer is not automatically approval: preserve refusal, defer and the full comment. Continue only the remaining authorized work in this original session. Collect completed results without repeating work. Do not ask the same question again or create another writer. Return the normal exact handoff receipt for the original handoff and current scope.',
    presentation: { topicMessage: null, title: p.deliveryContext.title, thinking: 'hidden', statusCard: 'hidden',
      deliveryContext: { ...p.deliveryContext, sourceAsk: { requestId: p.requestId, originKind: p.originKind } } },
    options: { asyncReturnSessionId: true, suppressFinalOutput: true, turnIdempotencyKey: key },
  };
}

/** Reserve under the original Ask identity, register outside that lock, and
 * reconcile with the very same idempotency key after any ambiguous failure. */
export async function continueManagedAsk(identity: AskLookupIdentity, deps: ManagedAskContinuationDeps) {
  const store = managedAskStore();
  const key = askKeyFor(identity.larkAppId, identity.sessionId, identity.originKind, identity.requestId);
  if (inFlight.has(key)) return { ok: false, state: 'unknown', reason: 'continuation_registration_in_flight' };
  inFlight.add(key);
  try {
    const reserved = store.update(key, p => {
      assertIdentity(p, identity);
      // Already registered: callers can recover its identity even after scope
      // changes. The Trigger's dispatch guard still applies to a reserved retry.
      if (p.continuation?.state === 'accepted' || p.continuation?.state === 'settled') return p;
      if (p.continuation?.request) {
        const registered = deps.lookupRegistered(p.continuation.request);
        if (registered) return { ...p, continuation: { ...p.continuation,
          state: 'accepted', triggerId: registered.triggerId, reason: 'registered_outcome_requires_lookup' } };
      }
      const proof = inspect(p, deps);
      const continuation = p.continuation ?? { key: `${p.requestId}:answered-continuation`,
        originalTurn: p.originalTurn, state: 'reserved' as const };
      if (proof.state === 'completed') return { ...p, presentation: { ...p.presentation, phase: 'result_recorded', revision: p.presentation.revision + 1 }, continuation: { ...continuation, state: 'settled', reason: 'professional_result_completed' } };
      return { ...p, continuation: { ...continuation, state: 'reserved',
        request: continuation.request ?? buildRequest(p, proof.resultRef!) } };
    });
    const c = reserved.continuation!;
    if (c.state === 'accepted' || c.state === 'settled') { refreshManagedAskPresentation(key); return { ok: true, continuation: c }; }
    const assertInputCurrent = () => {
      const current = store.get(key);
      if (!current.found) throw new ManagedAskError('managed_ask_original_missing');
      assertIdentity(current.record, identity);
      if (current.record.continuation?.key !== c.key || current.record.continuation.state !== 'reserved') {
        throw new ManagedAskError('managed_ask_continuation_changed', 409);
      }
      if (inspect(current.record, deps).state !== 'blocked') throw new ManagedAskError('managed_ask_professional_result_completed', 409);
    };
    try {
      const response = await deps.register(c.request!, assertInputCurrent);
      if (!response.triggerId || response.target?.sessionId !== identity.sessionId) {
        throw new ManagedAskError('managed_ask_continuation_registration_unknown');
      }
      const next = store.update(key, p => {
        if (p.continuation?.key !== c.key) throw new ManagedAskError('managed_ask_continuation_changed', 409);
        if (p.continuation.triggerId && p.continuation.triggerId !== response.triggerId) throw new ManagedAskError('managed_ask_continuation_trigger_conflict', 409);
        return { ...p, continuation: { ...p.continuation, triggerId: response.triggerId,
          state: response.ok ? 'accepted' : 'unknown', reason: response.ok ? undefined : 'trigger_outcome_unknown' } };
      });
      return { ok: response.ok, continuation: next.continuation, trigger: response };
    } catch (error) {
      // If registration landed but this write fails, the durable reserved
      // request still supplies the exact same key/payload on the next call.
      try { store.update(key, p => p.continuation?.state === 'accepted' ? p : ({ ...p,
        continuation: { ...p.continuation!, state: 'unknown', reason: 'registration_or_writeback_unknown' } })); } catch { /* keep original durable intent */ }
      return { ok: false, state: 'unknown', reason: error instanceof ManagedAskError ? error.code : 'registration_or_writeback_unknown' };
    }
  } finally { inFlight.delete(key); }
}
