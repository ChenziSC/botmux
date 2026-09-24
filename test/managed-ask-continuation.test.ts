import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetForTest, registerAsk, setAskPersistStore, setCardDispatcher, setCanTalkChecker,
  tryResolveAsk, lookupManagedAsk, recordManagedAskTerminal, restorePersistedAsks } from '../src/core/ask-broker.js';
import { createAskPersistStore, askKeyFor, HANDOFF_RETENTION_MS } from '../src/core/ask-persist-store.js';
import { continueManagedAsk, type ManagedAskContinuationDeps } from '../src/core/managed-ask-continuation.js';
import type { CreateAskInput, PendingAsk } from '../src/core/ask-types.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';

let dir: string;
let store: ReturnType<typeof createAskPersistStore>;
let sent: PendingAsk[];
const input: CreateAskInput = {
  larkAppId: 'app-a', sessionId: 'session-a', chatId: 'chat-a', rootMessageId: null,
  requestId: 'request-a', originKind: 'explicit', timeoutMs: 60000,
  questions: [{ prompt: 'Continue?', options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }], multiSelect: false }],
  managedDelivery: { version: 1, domain: 'ip', projectId: 'p-a', scopeRevision: 1, handoffId: 'handoff-a', stage: 'architecture', actor: 'leader', title: 'Design' },
  originalTurn: { turnId: 'turn-a', dispatchAttempt: 1 },
  originalExecution: { bootId: 'boot-a', workerGeneration: 2, replayKey: 'session-a\0handoff-a', replayKind: 'turn' },
};
const identity = { ...input, requestId: input.requestId!, originKind: input.originKind! };
const key = askKeyFor(input.larkAppId, input.sessionId, 'explicit', input.requestId!);
const terminal = { larkAppId: input.larkAppId, sessionId: input.sessionId, turnId: 'turn-a', dispatchAttempt: 1,
  workerGeneration: 2, bootId: 'boot-a', status: 'completed' as const };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function boot() {
  _resetForTest(); setAskPersistStore(store); setCanTalkChecker(() => true);
  setCardDispatcher({ async send(ask) { sent.push(ask); return { messageId: 'message-a' }; } });
}
async function answered(withTerminal = true) {
  const waiting = registerAsk(input); await flush();
  expect(tryResolveAsk({ askId: sent[0].askId, nonce: sent[0].nonce, selected: 'yes', by: 'owner' })).toBe('accepted');
  await waiting;
  if (withTerminal) recordManagedAskTerminal(terminal);
}
function deps(overrides: Partial<ManagedAskContinuationDeps> = {}): ManagedAskContinuationDeps {
  return { dataDir: dir, policy: () => ({ state: 'blocked', reason: 'exact_blocked_receipt', ownerOpenId: 'owner', resultRef: 'receipt-a' }),
    originalActive: () => false, answerAuthorized: () => true, lookupRegistered: () => undefined,
    readOriginalResult: () => ({ ownerLarkAppId: input.larkAppId, result: { status: 'completed', createdAt: 1, completedAt: 2, content: 'blocked receipt' } }),
    register: async (request, guard) => { guard(); return { ok: true, triggerId: 'continued', action: 'queued', target: { kind: 'turn', sessionId: input.sessionId, chatId: input.chatId } }; },
    ...overrides };
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ask-continuation-')); store = createAskPersistStore(dir); sent = []; boot(); });
afterEach(() => { _resetForTest(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('managed Ask continuation admission', () => {
  it('continues a keyed turn with an omitted attempt exactly once after restart', async () => {
    const keyed = { ...input, originalTurn: { turnId: 'turn-a' } };
    const promise = registerAsk(keyed); await flush();
    tryResolveAsk({ askId: sent[0].askId, nonce: sent[0].nonce, selected: 'yes', by: 'owner' });
    await promise;
    recordManagedAskTerminal({ ...terminal, dispatchAttempt: undefined });
    boot(); restorePersistedAsks();
    const register = vi.fn(deps().register);
    expect(await continueManagedAsk(identity, deps({ register }))).toMatchObject({ continuation: { state: 'accepted' } });
    expect(await continueManagedAsk(identity, deps({ register }))).toMatchObject({ continuation: { state: 'accepted' } });
    expect(register).toHaveBeenCalledTimes(1);
  });
  it('does not turn a disconnected waiter into native termination proof', async () => {
    const abort = new AbortController(); const promise = registerAsk({ ...input, waiterSignal: abort.signal });
    await flush(); const rejected = expect(promise).rejects.toThrow('waiter_disconnected'); abort.abort(); await rejected;
    tryResolveAsk({ askId: sent[0].askId, nonce: sent[0].nonce, selected: 'yes', by: 'owner' });
    await expect(continueManagedAsk(identity, deps())).rejects.toThrow('execution_unproven');
  });
  it.each(['larkAppId', 'sessionId', 'turnId', 'dispatchAttempt', 'workerGeneration', 'bootId'] as const)('ignores a terminal with wrong %s', async field => {
    await answered(false);
    recordManagedAskTerminal({ ...terminal, [field]: typeof terminal[field] === 'number' ? 99 : 'wrong' });
    await expect(continueManagedAsk(identity, deps())).rejects.toThrow('execution_unproven');
  });
  it('persists exact native proof and uses one fixed continuation across restart', async () => {
    await answered(); boot(); restorePersistedAsks();
    const register = vi.fn(deps().register);
    const first = await continueManagedAsk(identity, deps({ register }));
    expect(first).toMatchObject({ ok: true, continuation: { state: 'accepted', key: 'request-a:answered-continuation', triggerId: 'continued' } });
    boot(); restorePersistedAsks();
    expect(await continueManagedAsk(identity, deps({ register }))).toMatchObject({ ok: true, continuation: { triggerId: 'continued' } });
    expect(register).toHaveBeenCalledTimes(1);
    expect(() => registerAsk(input)).toThrow('consumption_transferred');
  });
  it.each(['active', 'unauthorized', 'missing_policy', 'wrong_owner', 'unknown_result', 'cancelled_scope', 'completed_trigger_without_professional_proof'])('refuses %s without registering', async reason => {
    await answered();
    const register = vi.fn(deps().register);
    const d = deps({ register });
    if (reason === 'active') d.originalActive = () => true;
    if (reason === 'unauthorized') d.answerAuthorized = () => false;
    if (reason === 'missing_policy') d.policy = undefined;
    if (reason === 'wrong_owner') d.policy = () => ({ state: 'blocked', ownerOpenId: 'other', reason, resultRef: 'receipt-a' });
    if (reason === 'unknown_result') d.readOriginalResult = () => ({ ownerLarkAppId: input.larkAppId, result: { status: 'failed', createdAt: 1, failedAt: 2, errorCode: 'trigger_failed', reason: 'dispatch_unknown' } });
    if (reason === 'cancelled_scope') d.policy = () => ({ state: 'invalid', reason, ownerOpenId: 'owner' });
    if (reason === 'completed_trigger_without_professional_proof') d.policy = () => ({ state: 'unknown', reason, ownerOpenId: 'owner' });
    await expect(continueManagedAsk(identity, d)).rejects.toThrow(); expect(register).not.toHaveBeenCalled();
  });
  it('collects an existing professional result without dispatch', async () => {
    await answered(); const register = vi.fn(deps().register);
    expect(await continueManagedAsk(identity, deps({ register, policy: () => ({ state: 'completed', reason: 'completed', ownerOpenId: 'owner', resultRef: 'receipt-a' }) })))
      .toMatchObject({ ok: true, continuation: { state: 'settled' } });
    expect(register).not.toHaveBeenCalled();
  });
  it('keeps exactly the same request after remote acceptance and a lost return', async () => {
    await answered(); const requests: TriggerRequest[] = [];
    let calls = 0;
    const register: ManagedAskContinuationDeps['register'] = async (request, guard) => {
      requests.push(structuredClone(request)); guard();
      if (calls++ === 0) throw new Error('response lost after accepted');
      return { ok: true, triggerId: 'continued', idempotent: true, target: { kind: 'turn', sessionId: input.sessionId, chatId: input.chatId } };
    };
    expect(await continueManagedAsk(identity, deps({ register }))).toMatchObject({ state: 'unknown' });
    boot(); restorePersistedAsks();
    expect(await continueManagedAsk(identity, deps({ register }))).toMatchObject({ ok: true });
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  });
  it('does not steal a reservation while registration is in flight', async () => {
    await answered(); let release!: () => void;
    const register: ManagedAskContinuationDeps['register'] = async (request, guard) => {
      await new Promise<void>(resolve => { release = resolve; }); return deps().register(request, guard);
    };
    const first = continueManagedAsk(identity, deps({ register }));
    expect(await continueManagedAsk(identity, deps({ register }))).toMatchObject({ state: 'unknown', reason: 'continuation_registration_in_flight' });
    release(); expect(await first).toMatchObject({ ok: true });
  });
  it('rechecks cancellation after reservation immediately before input submission', async () => {
    await answered(); let cancelled = false; let dispatched = false;
    const d = deps({ policy: () => ({ state: cancelled ? 'invalid' : 'blocked', reason: 'scope', ownerOpenId: 'owner', resultRef: 'receipt-a' }),
      register: async (_r, guard) => { cancelled = true; guard(); dispatched = true; throw new Error('unexpected'); } });
    expect(await continueManagedAsk(identity, d)).toMatchObject({ state: 'unknown', reason: 'managed_ask_scope_invalid' });
    expect(dispatched).toBe(false);
  });
  it('retains registration identity when the writeback committed then reported failure', async () => {
    await answered(); const update = store.managed!.update;
    vi.spyOn(store.managed!, 'update').mockImplementation((k, change) => {
      const value = update(k, change);
      if (value.continuation?.state === 'accepted') throw new Error('fsync result lost');
      return value;
    });
    const register = vi.fn(deps().register);
    expect(await continueManagedAsk(identity, deps({ register }))).toMatchObject({ state: 'unknown' });
    vi.restoreAllMocks();
    expect(await continueManagedAsk(identity, deps({ register }))).toMatchObject({ ok: true, continuation: { triggerId: 'continued' } });
    expect(register).toHaveBeenCalledTimes(1);
  });
  it('removes answer copies from frozen continuation requests at retention expiry', async () => {
    await answered(); await continueManagedAsk(identity, deps());
    store.managed!.expire(key, Date.now() + HANDOFF_RETENTION_MS + 1000);
    const saved = store.managed!.get(key); expect(saved.found).toBe(true);
    if (saved.found) { expect(saved.record.terminalResult).toBeUndefined(); expect(saved.record.continuation?.request).toBeUndefined(); }
    expect(lookupManagedAsk(identity)).toMatchObject({ state: 'unknown', reason: 'result_expired' });
  });
});

it('recovers the same registered trigger after lost return even if scope was subsequently cancelled', async () => {
  await answered();
  await continueManagedAsk(identity, deps({ register: async () => { throw new Error('lost after register'); } }));
  const register = vi.fn(deps().register);
  const result = await continueManagedAsk(identity, deps({ register,
    lookupRegistered: () => ({ triggerId: 'originally-registered' }),
    policy: () => ({ state: 'invalid', reason: 'cancelled' }) }));
  expect(result).toMatchObject({ ok: true, continuation: { triggerId: 'originally-registered', reason: 'registered_outcome_requires_lookup' } });
  expect(register).not.toHaveBeenCalled();
});
