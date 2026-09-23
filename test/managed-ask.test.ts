import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetForTest, registerAsk, setAskPersistStore, setCardDispatcher, setCanTalkChecker,
  tryResolveAsk, restorePersistedAsks, lookupManagedAsk, invalidateAll, toggleAsk, _getPending,
} from '../src/core/ask-broker.js';
import { createAskPersistStore, askKeyFor, HANDOFF_RETENTION_MS } from '../src/core/ask-persist-store.js';
import { parseAskBody } from '../src/core/ask-api.js';
import type { CreateAskInput, PendingAsk } from '../src/core/ask-types.js';
import { askReplyRoute } from '../src/core/ask-types.js';

let dir: string;
let store: ReturnType<typeof createAskPersistStore>;
let sent: PendingAsk[];
let notices: unknown[];
const input: CreateAskInput = {
  larkAppId: 'app-a', sessionId: 'session-a', chatId: 'chat-a', rootMessageId: null,
  requestId: 'request-a', originKind: 'explicit', timeoutMs: 60000,
  questions: [{ prompt: '继续吗？', options: [{ key: 'yes', label: '继续' }, { key: 'no', label: '暂停' }], multiSelect: false }],
  managedDelivery: { version: 1, domain: 'ip', projectId: 'p-a', scopeRevision: 1, handoffId: 'handoff-a', stage: 'architecture', actor: 'leader', title: '方案确认' },
  originalTurn: { turnId: 'turn-a', dispatchAttempt: 1 },
};
const identity = { ...input, requestId: input.requestId!, originKind: input.originKind! };
function boot() {
  _resetForTest();
  setAskPersistStore(store);
  setCanTalkChecker((_a, _c, by) => by === 'owner');
  setCardDispatcher({
    async send(ask) { sent.push(ask); return { messageId: `message-${ask.askId}` }; },
    onSettle(ask, result) { notices.push({ ask, result }); },
  });
}
function answer(selected = 'yes') {
  return tryResolveAsk({ askId: sent[0].askId, nonce: sent[0].nonce, selected, by: 'owner' });
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'managed-ask-'));
  store = createAskPersistStore(dir); sent = []; notices = []; boot();
});
afterEach(() => { _resetForTest(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('managed Ask durable acceptance and replay', () => {
  it('allows only one attached managed waiter and reconnects after a proven HTTP disconnect', async () => {
    const abort = new AbortController();
    const old = registerAsk({ ...input, waiterSignal: abort.signal });
    await flush();
    expect(() => registerAsk(input)).toThrow('waiter_attached');
    const oldResult = expect(old).rejects.toThrow('waiter_disconnected');
    abort.abort();
    await oldResult;
    expect(lookupManagedAsk(identity)).toMatchObject({ state: 'pending', waiter: 'unknown' });
    const reconnected = registerAsk(input);
    answer();
    expect(await reconnected).toMatchObject({ answers: [['yes']] });
    expect(sent).toHaveLength(1);
  });

  it('replays a missing card with the original UUID after restart and never accepts an already-aborted registration', async () => {
    const aborted = AbortSignal.abort();
    expect(() => registerAsk({ ...input, waiterSignal: aborted })).toThrow('waiter_disconnected');
    expect(sent).toHaveLength(0);
    setCardDispatcher({ async send(ask) { sent.push(ask); return new Promise(() => {}); } });
    void registerAsk(input); await flush();
    boot(); restorePersistedAsks();
    const resumed = registerAsk(input); await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1].dispatchUuid).toBe(sent[0].dispatchUuid);
    answer();
    expect(await resumed).toMatchObject({ kind: 'answered' });
  });

  it('persists explicit/PTY asks before sending and retains the answer after the waiter returns', async () => {
    const promise = registerAsk(input);
    await flush();
    expect(sent).toHaveLength(1);
    expect(lookupManagedAsk(identity)).toMatchObject({ state: 'pending', waiter: 'attached' });
    expect(answer()).toBe('accepted');
    expect(await promise).toMatchObject({ kind: 'answered', answers: [['yes']] });
    expect(lookupManagedAsk(identity)).toMatchObject({ state: 'terminal', terminalResult: { kind: 'answered' }, presentation: { state: 'pending' } });
    expect(answer()).toBe('already_settled');
    boot();
    expect(restorePersistedAsks(Date.now(), input.larkAppId)).toBe(1);
    expect(await registerAsk(input)).toMatchObject({ kind: 'answered', answers: [['yes']] });
    expect(sent).toHaveLength(1);
  });

  it('fails registration without sending or keeping a waiter when the first durable write fails', async () => {
    vi.spyOn(store.managed!, 'create').mockImplementation(() => { throw new Error('disk unavailable'); });
    await expect(registerAsk(input)).rejects.toThrow('disk unavailable');
    expect(sent).toHaveLength(0);
    expect(lookupManagedAsk(identity)).toMatchObject({ found: false });
  });

  it('does not acknowledge, release, or update the card until terminal fsync succeeds', async () => {
    let returned = false;
    const promise = registerAsk(input).then(r => { returned = true; return r; });
    await flush();
    const originalPut = store.managed!.put;
    const fail = vi.spyOn(store.managed!, 'put').mockImplementation(() => { throw new Error('ENOSPC'); });
    expect(answer()).toBe('persistence_failed');
    expect(askReplyRoute('persistence_failed')).toBe('retry');
    expect(askReplyRoute('accepted')).toBe('handled');
    expect(askReplyRoute('unauthorized')).toBe('passthrough');
    await flush();
    expect(returned).toBe(false);
    expect(notices).toHaveLength(0);
    expect(lookupManagedAsk(identity)).toMatchObject({ state: 'pending' });
    fail.mockImplementation(originalPut);
    expect(answer()).toBe('accepted');
    await promise;
    expect(notices).toHaveLength(1);
  });

  it('keeps a committed answer across lost return and rejects a competing different answer', async () => {
    const promise = registerAsk(input); await flush();
    const originalPut = store.managed!.put;
    const fail = vi.spyOn(store.managed!, 'put').mockImplementation(p => {
      originalPut(p); throw new Error('fsync acknowledgement lost');
    });
    expect(answer()).toBe('persistence_failed');
    fail.mockImplementation(originalPut);
    expect(answer('no')).toBe('persistence_failed');
    expect(answer()).toBe('accepted');
    expect(await promise).toMatchObject({ answers: [['yes']] });
    expect(notices).toHaveLength(1);
  });

  it('retains a dormant answer through two restarts without posting another question', async () => {
    void registerAsk(input); await flush(); boot(); restorePersistedAsks();
    expect(answer('no')).toBe('accepted');
    boot(); restorePersistedAsks();
    expect(await registerAsk(input)).toMatchObject({ answers: [['no']] });
    expect(sent).toHaveLength(1);
  });

  it('retains invalidation as invalidation and never reopens it', async () => {
    const promise = registerAsk(input); await flush();
    invalidateAll('cancelled');
    expect(await promise).toMatchObject({ kind: 'invalidated', reason: 'cancelled' });
    boot(); restorePersistedAsks();
    expect(await registerAsk(input)).toMatchObject({ kind: 'invalidated' });
    expect(sent).toHaveLength(1);
  });

  it('rolls back a checkbox on persistence failure so a retry cannot silently invert the choice', async () => {
    void registerAsk({ ...input, questions: [{ ...input.questions[0], multiSelect: true }] }); await flush();
    const put = store.managed!.put;
    const fail = vi.spyOn(store.managed!, 'put').mockImplementation(() => { throw new Error('disk full'); });
    const click = { askId: sent[0].askId, nonce: sent[0].nonce, questionIndex: 0, key: 'yes', by: 'owner' };
    expect(toggleAsk(click)).toBe('persistence_failed');
    expect(_getPending(sent[0].askId)?.selections).toEqual([[]]);
    fail.mockImplementation(put);
    expect(toggleAsk(click)).toBe('toggled');
    expect(_getPending(sent[0].askId)?.selections).toEqual([['yes']]);
  });

  it('recovers an expired pending request as timed out and retains the precise terminal', async () => {
    vi.useFakeTimers();
    try {
      const promise = registerAsk({ ...input, timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1001);
      expect(await promise).toMatchObject({ kind: 'timedOut' });
      boot(); restorePersistedAsks();
      expect(await registerAsk({ ...input, timeoutMs: 1000 })).toMatchObject({ kind: 'timedOut' });
      expect(sent).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('expires answer bodies during a long-running daemon, without waiting for a reboot', async () => {
    vi.useFakeTimers();
    try {
      const promise = registerAsk(input);
      await vi.advanceTimersByTimeAsync(1);
      answer(); await promise;
      await vi.advanceTimersByTimeAsync(HANDOFF_RETENTION_MS + 1);
      const key = askKeyFor(input.larkAppId, input.sessionId, 'explicit', input.requestId!);
      const saved = store.managed!.get(key);
      expect(saved).toMatchObject({ record: { phase: 'terminal', resultExpired: true } });
      expect(saved.found && saved.record.terminalResult).toBeUndefined();
      expect(() => registerAsk(input)).toThrow('result_expired');
    } finally { vi.useRealTimers(); }
  });

  it('a caller omitting managed metadata cannot create another question for a retained managed request', async () => {
    void registerAsk(input); await flush(); boot();
    expect(() => registerAsk({ ...input, managedDelivery: undefined, originalTurn: undefined })).toThrow('identity_conflict');
    expect(sent).toHaveLength(1);
  });

  it('rejects changed question, scope, original turn and hook origin under the same invocation', async () => {
    void registerAsk(input); await flush();
    for (const changed of [
      { managedDelivery: { ...input.managedDelivery!, scopeRevision: 2 } },
      { originalTurn: { turnId: 'turn-b', dispatchAttempt: 1 } },
      { questions: [{ ...input.questions[0], prompt: '另一个问题' }] },
    ]) expect(() => registerAsk({ ...input, ...changed })).toThrow('identity_conflict');
    expect(() => registerAsk({ ...input, originKind: 'hook' })).toThrow('identity_required');
    expect(sent).toHaveLength(1);
  });
});

describe('read-only queries and schema compatibility', () => {
  it('lookup never lists, claims, dispatches or creates a missing store', () => {
    const list = vi.spyOn(store.managed!, 'list');
    expect(lookupManagedAsk(identity)).toMatchObject({ found: false, reason: 'not_found' });
    expect(readdirSync(dir)).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it('queries do not change record bytes and reject the wrong chat/root/app/session', async () => {
    const promise = registerAsk(input); await flush(); answer(); await promise;
    const file = join(store.managed!.dir, readdirSync(store.managed!.dir)[0]);
    const before = readFileSync(file, 'utf8');
    for (let i = 0; i < 3; i++) lookupManagedAsk(identity);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(() => lookupManagedAsk({ ...identity, chatId: 'other' })).toThrow('identity_conflict');
    expect(() => lookupManagedAsk({ ...identity, rootMessageId: 'other' })).toThrow('identity_conflict');
    expect(lookupManagedAsk({ ...identity, larkAppId: 'other' })).toMatchObject({ found: false });
    expect(lookupManagedAsk({ ...identity, sessionId: 'other' })).toMatchObject({ found: false });
    expect(sent).toHaveLength(1);
  });

  it('preserves unknown schemas, keeps v3 out of v2 GC and returns unknown for malformed data', async () => {
    void registerAsk(input); await flush();
    writeFileSync(join(dir, 'future.json'), JSON.stringify({ v: 99 }));
    expect(store.list()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'future.json'), 'utf8'))).toEqual({ v: 99 });
    expect(lookupManagedAsk(identity)).toMatchObject({ state: 'pending' });
    const file = join(store.managed!.dir, readdirSync(store.managed!.dir)[0]);
    writeFileSync(file, '{broken');
    expect(lookupManagedAsk(identity)).toMatchObject({ state: 'unknown', reason: 'unreadable' });
    expect(readFileSync(file, 'utf8')).toBe('{broken');
  });

  it('expires answer bodies without resetting the original terminal or re-asking', async () => {
    const promise = registerAsk(input); await flush(); answer(); await promise;
    const future = Date.now() + HANDOFF_RETENTION_MS + 1;
    expect(lookupManagedAsk(identity, future)).toMatchObject({ state: 'unknown', reason: 'result_expired' });
    store.managed!.list(future); boot(); restorePersistedAsks(future);
    const key = askKeyFor(input.larkAppId, input.sessionId, 'explicit', input.requestId!);
    expect(store.managed!.get(key)).toMatchObject({ record: { resultExpired: true, phase: 'terminal' } });
    expect(() => registerAsk(input)).toThrow('result_expired');
    expect(sent).toHaveLength(1);
  });

  it('requires scope for Project/Issue contexts and strips caller-supplied authority fields', () => {
    expect(parseAskBody({ ...input, managedDelivery: { ...input.managedDelivery, scopeRevision: undefined } })).toEqual({ error: 'bad_managedDelivery' });
    const parsed = parseAskBody({ ...input, managedDelivery: { ...input.managedDelivery, trusted: true, originalTurn: 'forged' } });
    expect(parsed).toMatchObject({ managedDelivery: input.managedDelivery });
    expect('error' in parsed ? null : parsed.managedDelivery).not.toHaveProperty('trusted');
  });
});
