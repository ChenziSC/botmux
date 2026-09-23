import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAskPersistStore, askKeyFor } from '../src/core/ask-persist-store.js';
import { _resetForTest, registerAsk, setAskPersistStore, setCardDispatcher, setCanTalkChecker, tryResolveAsk,
  setManagedAskPresenter, advanceManagedAskPresentation } from '../src/core/ask-broker.js';
import { createManagedAskPresenter, buildManagedAskRuntimeCard, type ManagedAskPresentationIO } from '../src/core/managed-ask-presentation.js';
import type { CreateAskInput, PendingAsk } from '../src/core/ask-types.js';
import { freezeHandoffPreview, handoffPreviewElements, withHandoffPreview } from '../src/core/handoff-preview.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';

let dir: string;
let store: ReturnType<typeof createAskPersistStore>;
let ask: PendingAsk;
const input: CreateAskInput = { larkAppId: 'app', sessionId: 'session', chatId: 'oc_chat', rootMessageId: null,
  requestId: 'request', originKind: 'explicit', timeoutMs: 60000,
  questions: [{ prompt: '继续吗', multiSelect: false, options: [{ key: 'yes', label: '继续' }, { key: 'no', label: '暂缓' }] }],
  managedDelivery: { version: 1, domain: 'ip', handoffId: 'h', stage: 'validation', actor: 'quality', title: '验证关系卡片' },
  originalTurn: { turnId: 'turn', dispatchAttempt: 1 } };
const key = askKeyFor('app', 'session', 'explicit', 'request');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(async () => {
  _resetForTest(); dir = mkdtempSync(join(tmpdir(), 'ask-presentation-')); store = createAskPersistStore(dir);
  setAskPersistStore(store); setCanTalkChecker(() => true);
  setCardDispatcher({ async send(p) { ask = p; return { messageId: 'om_ask' }; } });
  const result = registerAsk(input); await flush();
  tryResolveAsk({ askId: ask.askId, nonce: ask.nonce, selected: 'yes', by: 'owner' }); await result;
});
afterEach(() => { _resetForTest(); rmSync(dir, { recursive: true, force: true }); });
function transport() {
  const io: ManagedAskPresentationIO = { send: vi.fn(async () => 'om_runtime'), patch: vi.fn(async () => {}),
    retire: vi.fn(() => ['om_old', 'om_ask', 'om_runtime']), remove: vi.fn(async () => {}) };
  return io;
}
const current = () => { const r = store.managed!.get(key); if (!r.found) throw new Error(r.reason); return r.record; };

describe('answered Ask runtime segment', () => {
  async function secondAsk() {
    const result = registerAsk({ ...input, requestId: 'second' }); await flush();
    tryResolveAsk({ askId: ask.askId, nonce: ask.nonce, selected: 'yes', by: 'owner' }); await result;
    return askKeyFor('app', 'session', 'explicit', 'second');
  }
  it('successive same-turn Asks keep monotone segments and cannot update an older segment', async () => {
    const io = transport(); vi.mocked(io.send).mockImplementation(async record => 'om_' + record.requestId);
    const p = createManagedAskPresenter(store.managed!, io); await p.publish(key);
    const before = current().presentation;
    const next = await secondAsk();
    await p.advance(key, 'running', 'turn');
    expect(current().presentation.phase).toBe(before.phase);
    vi.mocked(io.send).mockRejectedValueOnce(new Error('network down'));
    await p.publish(next);
    expect(vi.mocked(io.remove).mock.calls.some(call => call[1] === 'om_request')).toBe(false);
    await p.publish(next);
    expect(vi.mocked(io.remove).mock.calls.some(call => call[1] === 'om_request')).toBe(true);
    expect(current().presentation.supersededBy).toBe(next);
    const restored = createAskPersistStore(dir).managed!.get(next);
    expect(restored.found && restored.record.presentation.segment).toBe(before.segment! + 1);
    await p.advance(key, 'execution_completed', 'turn');
    expect(current().presentation.phase).toBe(before.phase);
  });
  it('a predecessor POST finishing after the new segment retires only its own late message', async () => {
    const io = transport(); let finish!: (id: string) => void;
    vi.mocked(io.send).mockImplementation(record => record.askKey === key
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve('om_second'));
    const p = createManagedAskPresenter(store.managed!, io);
    const oldPost = p.publish(key); await flush();
    const next = await secondAsk(); await p.publish(next);
    finish('om_first'); await oldPost;
    expect(current().presentation.retired).toBe(true);
    expect(vi.mocked(io.remove).mock.calls.some(call => call[1] === 'om_first')).toBe(true);
    expect(vi.mocked(io.remove).mock.calls.some(call => call[1] === 'om_second')).toBe(false);
  });
  it('live blocking can recover, but original terminal proof rejects a late working frame', async () => {
    const p = createManagedAskPresenter(store.managed!, transport());
    await p.advance(key, 'blocked', 'turn', 'rate_limit');
    expect(buildManagedAskRuntimeCard(current())).toContain('限流');
    const revision = current().presentation.revision;
    await p.advance(key, 'running', 'turn'); expect(current().presentation.revision).toBeGreaterThan(revision);
    store.managed!.update(key, record => ({ ...record, execution: { bootId: 'b', workerGeneration: 1,
      replayKey: 'r', replayKind: 'turn', terminal: { status: 'failed', observedAt: Date.now() } } }));
    await p.advance(key, 'unknown', 'turn'); await p.advance(key, 'running', 'turn');
    expect(current().presentation.phase).toBe('unknown');
  });
  it('a worker frame observed before answer acceptance cannot start its new segment', async () => {
    const p = createManagedAskPresenter(store.managed!, transport()); setManagedAskPresenter(p);
    store.managed!.update(key, record => ({ ...record, execution: { bootId: 'b', workerGeneration: 1,
      replayKey: 'r', replayKind: 'turn' } }));
    const identity = { larkAppId: 'app', sessionId: 'session', turnId: 'turn', dispatchAttempt: 1,
      workerGeneration: 1, phase: 'running' as const };
    advanceManagedAskPresentation({ ...identity, observedAt: current().acceptedAt! - 1 }); await flush();
    expect(current().presentation.phase).toBe('accepted');
    advanceManagedAskPresentation({ ...identity, observedAt: current().acceptedAt! + 1 }); await flush();
    expect(current().presentation.phase).toBe('running');
  });
  it('sends under original Ask once, persists first, and deletes only the owned runtime message', async () => {
    const io = transport(); io.retire = vi.fn(() => {
      expect(current().presentation.messageId).toBe('om_runtime'); return ['om_old', 'om_ask', 'om_runtime'];
    });
    const presenter = createManagedAskPresenter(store.managed!, io);
    await Promise.all([presenter.publish(key), presenter.publish(key)]);
    expect(io.send).toHaveBeenCalledTimes(1);
    expect(io.send).toHaveBeenCalledWith(expect.objectContaining({ cardMessageId: 'om_ask' }), expect.stringContaining('已收到答复'), expect.any(String));
    expect(io.remove).toHaveBeenCalledTimes(1);
    expect(io.remove).toHaveBeenCalledWith(expect.anything(), 'om_old');
    expect(current().presentation).toMatchObject({ state: 'sent', cleanupComplete: true });
  });
  it('keeps predecessors after POST uncertainty and reuses the UUID after process restart', async () => {
    const io = transport(); vi.mocked(io.send).mockRejectedValueOnce(new Error('response lost'));
    await createManagedAskPresenter(store.managed!, io).publish(key);
    expect(io.retire).not.toHaveBeenCalled(); expect(io.remove).not.toHaveBeenCalled();
    await createManagedAskPresenter(store.managed!, io).publish(key);
    expect(vi.mocked(io.send).mock.calls[0][2]).toBe(vi.mocked(io.send).mock.calls[1][2]);
  });
  it('retains cleanup_pending when withdrawal fails and retries only that owned ID', async () => {
    const io = transport(); vi.mocked(io.remove).mockRejectedValueOnce(new Error('unsupported'));
    const p = createManagedAskPresenter(store.managed!, io); await p.publish(key);
    expect(current().presentation).toMatchObject({ state: 'cleanup_pending', cleanupIds: ['om_old'] });
    await p.publish(key); expect(current().presentation.cleanupComplete).toBe(true);
    expect(io.send).toHaveBeenCalledTimes(1);
  });
  it('refreshes an event that races the POST and rejects delayed running after the same turn ended', async () => {
    const io = transport(); let finish!: (value: string) => void;
    vi.mocked(io.send).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const p = createManagedAskPresenter(store.managed!, io);
    const sent = p.publish(key); await flush();
    const ended = p.advance(key, 'execution_completed', 'turn'); finish('om_runtime');
    await Promise.all([sent, ended]); await p.advance(key, 'running', 'turn');
    expect(current().presentation.phase).toBe('execution_completed');
    expect(buildManagedAskRuntimeCard(current())).not.toContain('任务已完成');
    const count = vi.mocked(io.patch).mock.calls.length;
    await p.advance(key, 'running', 'other'); expect(io.patch).toHaveBeenCalledTimes(count);
  });
  it('does not detach predecessors before the cleanup plan is durable', async () => {
    const io = transport(); io.commitRetirement = vi.fn();
    const update = store.managed!.update.bind(store.managed); let fail = true;
    vi.spyOn(store.managed!, 'update').mockImplementation((key, change) => {
      const next = change(current());
      if (fail && next.presentation.cleanupIds) { fail = false; throw new Error('cleanup fsync failed'); }
      return update(key, () => next);
    });
    const presenter = createManagedAskPresenter(store.managed!, io); await presenter.publish(key);
    expect(io.commitRetirement).not.toHaveBeenCalled(); expect(io.remove).not.toHaveBeenCalled();
    await presenter.publish(key);
    expect(io.commitRetirement).toHaveBeenCalledWith(expect.anything(), ['om_old']);
    expect(current().presentation.cleanupComplete).toBe(true);
  });
  it('does not let a stale broker snapshot erase runtime references', async () => {
    const old = current(); await createManagedAskPresenter(store.managed!, transport()).publish(key);
    store.managed!.put({ ...old, cardMessageId: 'om_ask' });
    expect(current().presentation.messageId).toBe('om_runtime');
  });
});

describe('actual handoff preview', () => {
  it('redacts complete HTTP credential values with spaces and multiple cookies', () => {
    const preview = freezeHandoffPreview({ presentation: { deliveryContext: input.managedDelivery },
      envelope: { payload: { handoff: 'Authorization: Bearer example-auth-value\nCookie: first=example-cookie-one; session=example-cookie-two\n正常交接内容',
        stage_input: { headers: { Authorization: 'Basic example-basic-value', Cookie: 'a=example-cookie-three; b=example-cookie-four' } } } } } as TriggerRequest)!;
    expect(preview.text).not.toMatch(/example-(auth|cookie|basic)/);
    expect(preview.text).toContain('正常交接内容'); expect(preview.redacted).toBe(true);
  });
  it('redacts secrets, excludes system instructions and keeps default collapse across schema conversion', () => {
    const request = { presentation: { deliveryContext: input.managedDelivery }, instruction: 'SYSTEM SECRET',
      envelope: { payload: { handoff: 'Review links. api_key=abc123', stage_input: { delta: 'only cards' } } } } as TriggerRequest;
    const preview = freezeHandoffPreview(request)!;
    expect(preview.text).not.toContain('abc123'); expect(preview.text).not.toContain('SYSTEM SECRET');
    expect(preview.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(handoffPreviewElements(undefined))).toContain('未留存');
    expect(preview.text).toContain('only cards'); expect(preview.displayHash).not.toBe(preview.originalHash);
    const result = JSON.parse(withHandoffPreview(JSON.stringify({ elements: [
      { tag: 'action', actions: [{ tag: 'button', value: { action: 'stop_turn' } }] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: 'hint' }] },
    ] }), preview));
    expect(result.schema).toBe('2.0'); expect(result.body.elements.at(-1).expanded).toBe(false);
    expect(result.body.elements[0].columns[0].elements[0].value.action).toBe('stop_turn');
    expect(result.body.elements[0].flex_mode).toBe('none');
    expect(result.body.elements[1].tag).toBe('markdown');
  });
  it('keeps long complete handoff in its durable snapshot and exposes attachment delivery honestly', () => {
    const text = '验收条件与滚动容器。'.repeat(2000);
    const preview = freezeHandoffPreview({ presentation: { deliveryContext: input.managedDelivery }, envelope: { payload: { handoff: text } } } as TriggerRequest)!;
    expect(preview.text).toBe(text);
    expect(JSON.stringify(handoffPreviewElements(preview))).toContain('附件正在发送');
    preview.overflowMessageId = 'om_file';
    expect(JSON.stringify(handoffPreviewElements(preview))).toContain('已发送');
  });
});
