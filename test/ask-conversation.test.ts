import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AskConversationService, type ConversationDeps } from '../src/core/ask-conversation.js';
import { createConversationStore, conversationKey } from '../src/core/ask-conversation-store.js';
import type { ConversationIdentity, ConversationResolution } from '../src/core/ask-conversation-types.js';
import { buildConversationCard, buildConversationReplyCard, conversationLarkIO, handleConversationCard, routeConversationMessage } from '../src/im/lark/ask-conversation.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ask-conversation-')); dirs.push(dir);
  const store = createConversationStore(dir);
  const identity: ConversationIdentity = { larkAppId: 'cli_bot', chatId: 'oc_chat', sessionId: 'session',
    rootMessageId: null, originKind: 'explicit', requestId: 'question-a', policyKey: 'test-policy', subjectRef: 'opaque', subjectRevision: '1' };
  let clock = 10000; let busy = true; let denied = false; let sendFail = false; let lost = false;
  const registered = new Map<string, { triggerId: string }>();
  const terminal = new Map<string, 'pending' | 'completed' | 'failed' | 'unknown'>();
  const posts: Array<{ id: string; kind: string; uuid: string }> = []; const deleted: string[] = [];
  const requests: any[] = [];
  const deps: ConversationDeps = { store, dataDir: dir, now: () => clock,
    policy: () => denied ? { state: 'invalid', reason: 'cancelled' }
      : { state: 'valid', reason: 'test', decisionPrincipals: ['ou_owner'], resultVerified: true },
    canStart: () => !busy,
    lookup: request => registered.get(request.source.requestId!),
    terminal: (_p, id) => terminal.get(id) ?? 'unknown',
    register: async (request, guard) => {
      guard(); requests.push(request);
      const hit = { triggerId: `trg_${requests.length}` }; registered.set(request.source.requestId!, hit); terminal.set(hit.triggerId, 'pending');
      if (lost) throw new Error('response lost after durable registration');
      return { ok: true, ...hit, target: { kind: 'turn', sessionId: identity.sessionId } };
    },
    send: async (_p, effect, uuid) => {
      if (sendFail) throw new Error('offline');
      const old = posts.find(p => p.uuid === uuid); if (old) return old.id;
      const id = 'om_' + posts.length; posts.push({ id, kind: effect.kind, uuid }); return id;
    },
    patch: async () => {}, remove: async (_p, id) => { deleted.push(id); },
  };
  const service = new AskConversationService(deps);
  const create = () => service.create(identity, { title: 'Deployment question',
    questions: [{ id: 'q1', prompt: 'How should this task continue?', multiSelect: false,
      options: [{ key: 'yes', label: 'Continue' }, { key: 'defer', label: 'Pause' }] }] }, 'original');
  const key = conversationKey(identity);
  const read = () => store.get(key)!;
  const input = (id: string, text = 'Can the CLI do it?') => service.ingest(key, { id, by: 'ou_owner', receivedAt: clock++, text, attachments: [] });
  const start = async () => { busy = false; service.tick(identity.larkAppId); await service.drain(); return read().turns.at(-1)!; };
  const commitInput = () => { const t = read().turns.at(-1)!; service.onInputCommitted(identity.larkAppId, identity.sessionId, t.triggerId!, 'native:1'); return t; };
  const resolution = (outcome: ConversationResolution['outcome'] = 'proceed'): ConversationResolution => ({ revision: 0,
    basisThrough: read().inbox.length, questionRevision: 1, subjectRevision: '1', ownerGeneration: 1,
    sourceInputIds: [read().inbox.at(-1)!.id], outcome, summary: 'Use the CLI only in the test environment',
    conditions: ['test environment only'], answers: [{ questionId: 'q1', sourceInputIds: [read().inbox.at(-1)!.id], disposition: 'answered' }] });
  const commit = (candidate?: ConversationResolution) => {
    const t = read().turns.at(-1)!;
    return service.commit(identity, { batchId: t.key, expectedVersion: read().stateVersion,
      response: candidate ? 'Agreed: test environment only.' : 'The CLI supports this. Which test environment?',
      ...(candidate ? { resolution: candidate } : { needsInput: true }) }, t.triggerId!);
  };
  return { dir, store, service, deps, identity, key, create, read, input, start, commitInput, commit, resolution,
    posts, deleted, requests, terminal, registered,
    setBusy: (v: boolean) => { busy = v; }, deny: () => { denied = true; },
    sendFail: (v: boolean) => { sendFail = v; }, loseRegistration: () => { lost = true; },
    advance: (ms: number) => { clock += ms; } };
}
describe('durable non-blocking conversation', () => {
  it('returns a registered checkpoint before network/human waits; reads do not mutate', async () => {
    const f = fixture(); const result = f.create();
    expect(result.registered).toBe(true); expect(result.checkpoint).toBe('awaiting_decision');
    expect(f.posts).toHaveLength(0); expect(f.read().nextActor).toBe('agent');
    await f.service.drain(); expect(f.read().nextActor).toBe('human'); expect(f.requests).toHaveLength(0);
    const before = JSON.stringify(f.read()); f.service.read(f.identity); expect(JSON.stringify(f.read())).toBe(before);
  });
  it('strict create rejects changed questions and cross-session reads', async () => {
    const f = fixture(); f.create(); await f.service.drain();
    expect(() => f.service.create(f.identity, { title: 'Changed', questions: [{ id: 'q1', prompt: 'New scope', options: [], multiSelect: false }] }, 'original')).toThrow(/conflict/);
    expect(() => f.service.read({ ...f.identity, chatId: 'oc_other' })).toThrow(/identity_conflict/);
  });
  it('duplicate input is durable and does not settle or start a busy role', async () => {
    const f = fixture(); f.create(); await f.service.drain(); f.input('om_user'); f.input('om_user'); await f.service.drain();
    expect(f.read().inbox).toHaveLength(1); expect(f.read().lifecycle).toBe('open');
    expect(f.read().nextActor).toBe('agent'); expect(f.requests).toHaveLength(0);
    expect(createConversationStore(f.dir).get(f.key)?.inbox[0].text).toBe('Can the CLI do it?');
    await f.start(); expect(f.requests).toHaveLength(1); expect(f.requests[0].target.sessionId).toBe('session');
    expect(f.requests[0].target.rootMessageId).toBeUndefined();
  });
  it('failed persistence cannot acknowledge an input', async () => {
    const f = fixture(); f.create(); await f.service.drain();
    const name = readdirSync(join(f.dir, 'managed-v4')).find(n => n.endsWith('.json'))!;
    writeFileSync(join(f.dir, 'managed-v4', name), '{');
    expect(() => f.input('om_user')).toThrow(/unreadable/); expect(f.requests).toHaveLength(0);
  });
  it('input registration is not input commitment', async () => {
    const f = fixture(); f.create(); await f.service.drain(); f.input('om_u1'); await f.start();
    expect(buildConversationCard(f.read(), true)).toContain('等待继续处理');
    expect(() => f.commit()).toThrow(/batch_not_owned/);
    f.commitInput(); await f.service.drain(); expect(buildConversationCard(f.read(), true)).toContain('正在处理你的答复');
    f.commit(); await f.service.drain(); expect(f.read().nextActor).toBe('human');
  });
  it('three discussion rounds retain topic replies and only the clear decision applies', async () => {
    const f = fixture(); f.create(); await f.service.drain();
    for (let i = 1; i <= 3; i++) {
      f.input(`om_u${i}`, i === 3 ? 'Yes, use it only in the test environment' : 'Explain more');
      await f.start(); const t = f.commitInput(); await f.service.drain();
      f.commit(i === 3 ? f.resolution() : undefined); await f.service.drain();
      expect(f.read().application?.triggerId).toBeUndefined();
      f.terminal.set(t.triggerId!, 'completed'); f.service.tick(f.identity.larkAppId); await f.service.drain();
      if (i < 3) expect(f.read().application).toBeUndefined();
    }
    expect(f.requests).toHaveLength(4); expect(f.requests.at(-1).source.requestId).toBe(`${f.key}:1:apply`);
    expect(f.posts.filter(p => p.kind === 'reply')).toHaveLength(3);
    const a = f.read().application!;
    f.service.onInputCommitted('cli_bot', 'session', a.triggerId!, 'native:apply');
    f.service.applied(f.identity, { applicationKey: a.key, resultRef: `trigger:${a.triggerId}` }, a.triggerId!);
    expect(f.read().lifecycle).toBe('resolved'); // native final still missing
    f.terminal.set(a.triggerId!, 'completed'); f.service.tick('cli_bot'); await f.service.drain();
    expect(f.read().lifecycle).toBe('applied'); expect(f.posts.filter(p => p.kind === 'summary')).toHaveLength(1);
    f.service.tick('cli_bot'); await f.service.drain(); expect(f.requests).toHaveLength(4);
  });
  it.each(['decline', 'defer', 'cancel', 'resolved_externally'] as const)('retains %s independently of proceed', async outcome => {
    const f = fixture(); f.create(); await f.service.drain(); f.input('om_u'); await f.start(); f.commitInput();
    f.commit(f.resolution(outcome)); expect(f.read().resolution?.outcome).toBe(outcome);
    expect(f.read().resolution?.conditions).toEqual(['test environment only']); await f.service.drain();
  });
  it('a later condition invalidates both stale candidates and unapplied resolutions', async () => {
    const f = fixture(); f.create(); await f.service.drain(); f.input('om_u1'); await f.start(); f.commitInput();
    const c = f.resolution(); f.input('om_u2', 'Actually do not change anything');
    expect(() => f.commit(c)).toThrow(/stale_or_invalid/);
    expect(f.read().inbox.map(e => e.id)).toEqual(['om_u1', 'om_u2']); await f.service.drain();
  });
  it('new input before registration discards the application intent', async () => {
    const f = fixture(); f.create(); await f.service.drain(); f.input('om_u'); await f.start(); f.commitInput();
    f.commit(f.resolution()); f.input('om_correction', 'Stop');
    expect(f.read().application).toBeUndefined(); expect(f.read().lifecycle).toBe('open'); await f.service.drain();
  });
  it('scope revocation fails closed before any new execution', async () => {
    const f = fixture(); f.create(); await f.service.drain(); f.input('om_u'); f.deny(); await f.start();
    expect(f.requests).toHaveLength(0); expect(f.read().lastError).toBe('policy_recheck_required');
  });
  it('recovers a registered trigger after response loss with no second execution', async () => {
    const f = fixture(); f.create(); await f.service.drain(); f.input('om_u'); f.loseRegistration(); await f.start();
    expect(f.requests).toHaveLength(1);
    const restored = new AskConversationService({ ...f.deps, store: createConversationStore(f.dir) });
    restored.tick('cli_bot'); await restored.drain(); expect(f.requests).toHaveLength(1);
    expect(f.read().turns[0].triggerId).toBe('trg_1');
  });
  it('does not rerun a model whose final lacks a committed substantive response', async () => {
    const f = fixture(); f.create(); await f.service.drain(); f.input('om_u'); await f.start();
    f.terminal.set('trg_1', 'completed'); f.service.tick('cli_bot'); await f.service.drain();
    expect(f.read().lastError).toBe('discussion_result_uncommitted'); expect(f.requests).toHaveLength(1);
  });
  it('reply send failures preserve the response and keep responsibility with the bot', async () => {
    const f = fixture(); f.create(); await f.service.drain(); f.input('om_u'); await f.start(); f.commitInput();
    f.sendFail(true); f.commit(); await f.service.drain();
    expect(f.read().nextActor).toBe('agent'); expect(f.read().responses).toHaveLength(1);
    f.sendFail(false); f.advance(5000); f.service.tick('cli_bot'); await f.service.drain();
    expect(f.read().nextActor).toBe('human'); expect(f.requests).toHaveLength(1);
  });
  it('late send receipt cannot override newer input responsibility', async () => {
    const f = fixture(); f.create(); await f.service.drain(); f.input('om_u'); await f.start(); f.commitInput();
    const original = f.deps.send;
    f.deps.send = async (p, e, uuid) => { if (e.kind === 'reply') f.input('om_later', 'More details'); return original(p, e, uuid); };
    f.commit(); await f.service.drain(); expect(f.read().nextActor).toBe('agent');
  });
  it('new input creates a new runtime segment and deletes only old same-chain runtime IDs', async () => {
    const f = fixture(); f.create(); await f.service.drain(); f.input('om_u1'); await f.service.drain();
    const first = f.posts.find(p => p.kind === 'runtime')!;
    f.input('om_u2'); await f.service.drain(); expect(f.deleted).toEqual([first.id]);
    expect(f.deleted).not.toContain(f.read().anchors.cardMessageId); expect(f.deleted).not.toContain('om_u1');
  });
  it('timeout retains history and a late valid input resumes without approval', async () => {
    const f = fixture(); f.create(); await f.service.drain(); f.advance(4000000); f.service.tick('cli_bot'); await f.service.drain();
    expect(f.read().waiting.timedOutAt).toBeDefined(); expect(f.read().lifecycle).toBe('open');
    f.input('om_late'); await f.start(); expect(f.read().resolution).toBeUndefined(); expect(f.requests).toHaveLength(1);
  });
});
describe('exact original-topic routing', () => {
  it('matches native thread or parent/root references, but never an unreferenced group message', async () => {
    const f = fixture(); f.create(); await f.service.drain();
    const card = f.read().anchors.cardMessageId!;
    expect(f.service.find('cli_bot', 'oc_chat', {})).toBeUndefined();
    expect(f.service.find('cli_bot', 'oc_other', { rootId: card })).toBeUndefined();
    const data = { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
      message: { message_id: 'om_attachment', parent_id: card, chat_id: 'oc_chat', chat_type: 'group',
        create_time: '20000', message_type: 'file', content: JSON.stringify({ file_key: 'file_key', file_name: 'context.txt' }) } };
    expect(await routeConversationMessage(f.service, data, 'cli_bot')).toBe(true); await f.service.drain();
    expect(f.read().inbox[0].attachments[0].key).toBe('file_key');
    f.store.update(f.key, p => { p.anchors.threadId = 'omt_topic'; p.anchors.replyIds.push('om_explanation'); });
    expect(f.service.find('cli_bot', 'oc_chat', { threadId: 'omt_topic' })?.askKey).toBe(f.key);
    expect(f.service.find('cli_bot', 'oc_chat', { parentId: 'om_explanation' })?.askKey).toBe(f.key);
    expect(f.read().identity.rootMessageId).toBeNull();
  });
  it('keeps slash commands and bot messages outside discussion', async () => {
    const f = fixture(); f.create(); await f.service.drain();
    const data = { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
      message: { message_id: 'om_stop', root_id: f.read().anchors.cardMessageId, chat_id: 'oc_chat',
        message_type: 'text', content: JSON.stringify({ text: '/stop' }) } };
    expect(await routeConversationMessage(f.service, data, 'cli_bot')).toBe(false);
    data.sender.sender_type = 'app'; expect(await routeConversationMessage(f.service, data, 'cli_bot')).toBe(false);
  });
  it('a valid button is input, stale buttons never overwrite later text', async () => {
    const f = fixture(); f.create(); await f.service.drain();
    const action = { context: { open_message_id: f.read().anchors.cardMessageId }, operator: { open_id: 'ou_owner' },
      action: { value: { action: 'ask_conversation_select', askKey: f.key, questionRevision: 1, basisThrough: 0, questionId: 'q1', key: 'yes' } } };
    expect(handleConversationCard(f.service, action, 'cli_bot', () => true)?.toast.type).toBe('success');
    expect(f.read().resolution).toBeUndefined(); f.input('om_conditions', 'Only inspect');
    expect(handleConversationCard(f.service, action, 'cli_bot', () => true)?.toast.type).toBe('error');
    expect(f.read().inbox).toHaveLength(2); await f.service.drain();
  });
  it('explicit revision preserves question history and invalidates old buttons', async () => {
    const f = fixture(); f.create(); await f.service.drain();
    f.service.revise(f.identity, { expectedVersion: f.read().stateVersion, reason: 'Scope clarified',
      questions: [{ id: 'q1', prompt: 'Test only?', multiSelect: false, options: [] }] });
    expect(f.read().question.revision).toBe(2); expect(f.read().questionHistory[0].snapshot[0].prompt).toContain('continue');
    await f.service.drain(); expect(f.posts.filter(p => p.kind === 'question')).toHaveLength(1);
  });
});

it('different Ask topics on one session have at most one registered execution', async () => {
  const f = fixture(); f.create(); await f.service.drain(); f.input('om_first');
  const second = { ...f.identity, requestId: 'second' };
  f.service.create(second, { title: 'Second', questions: [{ id: 'q2', prompt: 'Another question', options: [], multiSelect: false }] }, 'original');
  await f.service.drain();
  f.service.ingest(conversationKey(second), { id: 'om_second', by: 'ou_owner', receivedAt: 10001, text: 'Second input', attachments: [] });
  await f.start(); expect(f.requests).toHaveLength(1);
  expect(f.service.find('cli_bot', 'oc_chat', { rootId: f.service.read(second)!.anchors.cardMessageId })?.identity.requestId).toBe('second');
});
it('member supplements are kept but cannot fabricate the designated decision maker', async () => {
  const f = fixture(); f.create(); await f.service.drain();
  f.service.ingest(f.key, { id: 'om_member', by: 'ou_member', receivedAt: 10001, text: 'An observation', attachments: [] });
  await f.start(); f.commitInput(); expect(() => f.commit(f.resolution())).toThrow(/sources_missing/);
  f.commit(); await f.service.drain(); expect(f.read().inbox[0].by).toBe('ou_member');
});
it('a cancelled policy arriving inside registration stops native input and retains the fixed key', async () => {
  const f = fixture(); f.create(); await f.service.drain(); f.input('om_u'); await f.start();
  const t = f.commitInput(); f.commit(f.resolution()); await f.service.drain(); f.terminal.set(t.triggerId!, 'completed');
  const register = f.deps.register;
  f.deps.register = async (request, guard) => { f.deny(); return register(request, guard); };
  f.service.tick('cli_bot'); await f.service.drain(); expect(f.requests).toHaveLength(1);
  expect(f.read().application?.key).toBe(`${f.key}:1:apply`);
  expect(f.read().lastError).toBe('registration_unconfirmed');
});
it('a crash before apply registration resumes the frozen intent, not a new action', async () => {
  const f = fixture(); f.create(); await f.service.drain(); f.input('om_u'); await f.start();
  const t = f.commitInput(); f.commit(f.resolution()); await f.service.drain(); f.terminal.set(t.triggerId!, 'completed');
  const register = f.deps.register;
  f.deps.register = async () => { throw new Error('before registry'); };
  f.service.tick('cli_bot'); await f.service.drain(); const request = f.read().application!.request;
  expect(f.read().application!.state).toBe('reserved');
  f.deps.register = register;
  const restored = new AskConversationService(f.deps); restored.tick('cli_bot'); await restored.drain();
  expect(f.requests).toHaveLength(2); expect(f.requests[1]).toEqual(request);
});

it('native thread-only events recover exact references without inventing a task', async () => {
  const f = fixture(); f.create(); await f.service.drain();
  const data = { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: {
    message_id: 'om_native', thread_id: 'omt_native', chat_id: 'oc_chat', message_type: 'text', content: JSON.stringify({ text: 'A follow-up' }) } };
  const resolve = async () => ({ items: [{ message_id: 'om_native', thread_id: 'omt_native', chat_id: 'oc_chat', root_id: f.read().anchors.cardMessageId }] });
  expect(await routeConversationMessage(f.service, data, 'cli_bot', resolve)).toBe(true);
  await f.service.drain(); expect(f.read().anchors.threadId).toBe('omt_native'); expect(f.read().inbox).toHaveLength(1);
});
it('audio is retained as an accessible message attachment, not just its placeholder', async () => {
  const f = fixture(); f.create(); await f.service.drain();
  const data = { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: {
    message_id: 'om_audio', root_id: f.read().anchors.cardMessageId, chat_id: 'oc_chat', message_type: 'audio', content: JSON.stringify({ file_key: 'audio_file', duration: 900 }) } };
  expect(await routeConversationMessage(f.service, data, 'cli_bot')).toBe(true); await f.service.drain();
  expect(f.read().inbox[0].attachments).toEqual([{ messageId: 'om_audio', type: 'audio', key: 'audio_file' }]);
});
it('read pagination keeps a total input cursor and omits repeated historical Trigger payloads', async () => {
  const { conversationReadView } = await import('../src/core/ask-conversation.js');
  const f = fixture(); f.create(); await f.service.drain();
  for (let i = 0; i < 4; i++) f.input(`om_long${i}`, 'x'.repeat(60000));
  const first = conversationReadView(f.read()); expect(first.inputThrough).toBe(4); expect(first.hasMore).toBe(true);
  const second = conversationReadView(f.read(), first.nextCursor);
  expect([...first.inbox, ...second.inbox].map(e => e.id)).toEqual(f.read().inbox.map(e => e.id));
  expect(() => conversationReadView(f.read(), -1)).toThrow(/bad_cursor/); await f.service.drain();
});

it('exact parent and received input references win over a topic shared by several Ask cards', async () => {
  const f = fixture(); f.create(); await f.service.drain();
  const second = { ...f.identity, requestId: 'second-in-topic' };
  f.service.create(second, { title: 'Second', questions: [{ id: 'q2', prompt: 'Second question', multiSelect: false, options: [] }] }, 'original');
  await f.service.drain();
  for (const p of f.store.scan()) f.store.update(p.askKey, x => { x.anchors.threadId = 'omt_shared'; });
  f.input('om_answer_first');
  const card2 = f.service.read(second)!.anchors.cardMessageId!;
  expect(f.service.find('cli_bot', 'oc_chat', { threadId: 'omt_shared', rootId: card2, parentId: 'om_answer_first' })?.askKey).toBe(f.key);
  expect(f.service.find('cli_bot', 'oc_chat', { threadId: 'omt_shared', parentId: card2 })?.identity.requestId).toBe(second.requestId);
  expect(() => f.service.find('cli_bot', 'oc_chat', { threadId: 'omt_shared' })).toThrow(/ambiguous_anchor/);
  const data = { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: {
    message_id: 'om_thread_only', thread_id: 'omt_shared', chat_id: 'oc_chat', message_type: 'text', content: JSON.stringify({ text: 'Clarify the second question' }) } };
  const resolve = async () => ({ items: [{ ...data.message, parent_id: card2 }] });
  expect(await routeConversationMessage(f.service, data, 'cli_bot', resolve)).toBe(true);
  expect(f.service.read(second)!.inbox[0].id).toBe('om_thread_only'); await f.service.drain();
});

function cardAction(f: ReturnType<typeof fixture>, action: string, extra: Record<string, string> = {}) {
  const p = f.read();
  return { context: { open_message_id: p.anchors.cardMessageId }, operator: { open_id: 'ou_owner' },
    action: { value: { action, askKey: f.key, questionRevision: String(p.question.revision),
      basisThrough: String(p.inbox.length), selectionVersion: String(p.selectionVersion ?? 0), ...extra } } };
}
it('multi-select clicks persist a draft without dispatching and submit all selected choices together', async () => {
  const f = fixture();
  f.service.create(f.identity, { title: 'Choose', questions: [{ id: 'q1', prompt: 'Which?', multiSelect: true,
    options: [{ key: 'one', label: 'One' }, { key: 'two', label: 'Two' }] }] }, 'original');
  await f.service.drain();
  const first = cardAction(f, 'ask_conversation_select', { questionId: 'q1', key: 'one' });
  expect(handleConversationCard(f.service, first, 'cli_bot', () => true)?.card).toBeDefined();
  expect(handleConversationCard(f.service, first, 'cli_bot', () => true)?.toast?.type).toBe('error');
  handleConversationCard(f.service, cardAction(f, 'ask_conversation_select', { questionId: 'q1', key: 'two' }), 'cli_bot', () => true);
  await f.start(); expect(f.requests).toHaveLength(0); expect(f.read().inbox).toHaveLength(0);
  expect(buildConversationCard(f.read())).toContain('☑ One');
  const restored = new AskConversationService(f.deps);
  const submit = cardAction(f, 'ask_conversation_submit');
  expect(handleConversationCard(restored, submit, 'cli_bot', () => true)?.toast?.type).toBe('success');
  expect(handleConversationCard(restored, submit, 'cli_bot', () => true)?.toast?.type).toBe('error');
  await restored.drain();
  expect(f.read().inbox).toHaveLength(1); expect(f.read().inbox[0].answers).toEqual([{ questionId: 'q1', keys: ['one', 'two'] }]);
  expect(f.requests).toHaveLength(1);
});
it('empty multi-select keeps the existing explicit confirmation and newer text invalidates drafts', async () => {
  const f = fixture();
  f.service.create(f.identity, { title: 'Choose', questions: [{ id: 'q1', prompt: 'Which?', multiSelect: true,
    options: [{ key: 'one', label: 'One' }] }] }, 'original');
  await f.service.drain();
  const armed = handleConversationCard(f.service, cardAction(f, 'ask_conversation_submit'), 'cli_bot', () => true);
  expect(JSON.stringify(armed?.card)).toContain('确认空提交'); expect(f.read().inbox).toHaveLength(0);
  const submit = cardAction(f, 'ask_conversation_submit', { confirmEmpty: 'true' });
  expect(handleConversationCard(f.service, submit, 'cli_bot', () => true)?.toast?.type).toBe('success');
  expect(f.read().inbox[0].answers![0].keys).toEqual([]);
  await f.service.drain();
  const g = fixture(); g.service.create(g.identity, { title: 'Choose', questions: [
    { id: 'q1', prompt: 'Which?', multiSelect: true, options: [{ key: 'one', label: 'One' }] }] }, 'original');
  await g.service.drain();
  handleConversationCard(g.service, cardAction(g, 'ask_conversation_select', { questionId: 'q1', key: 'one' }), 'cli_bot', () => true);
  const stale = cardAction(g, 'ask_conversation_submit'); g.input('om_text', 'Please explain first');
  expect(g.read().selections).toEqual({});
  expect(handleConversationCard(g.service, stale, 'cli_bot', () => true)?.toast?.type).toBe('error');
  await g.service.drain(); expect(g.read().inbox).toHaveLength(1);
});

describe('explicit conclusion and flow delivery in the original Ask reply', () => {
  function transport() {
    const sent: Array<{ id: string; destination: string; content: string; kind: string; uuid?: string }> = [];
    const cards = new Map<string, string>();
    let failSummary = false;
    const send = async (destination: string, content: string, kind: string, uuid?: string) => {
      if (kind === 'text' && failSummary) throw new Error('main-flow delivery unavailable');
      const old = sent.find(s => s.uuid === uuid); if (old) return old.id;
      const id = `om_sent_${sent.length}`; sent.push({ id, destination, content, kind, uuid }); cards.set(id, content); return id;
    };
    const client: NonNullable<Parameters<typeof conversationLarkIO>[0]> = {
      sendMessage: async (_app, chat, content, kind, uuid) => send(chat, content, kind ?? 'text', uuid),
      replyMessage: async (_app, parent, content, kind, _thread, uuid) => send(parent, content, kind ?? 'text', uuid),
      updateMessage: async (_app, id, content) => { cards.set(id, content); },
      deleteMessage: async () => true,
    };
    return { client, sent, cards, failSummary: (value: boolean) => { failSummary = value; } };
  }
  const top = (body: string) => JSON.parse(body).body.elements[0].content as string;
  it('sends an actual Markdown card with the unresolved status and the concrete question', async () => {
    const f = fixture(); const im = transport(); Object.assign(f.deps, conversationLarkIO(im.client));
    f.create(); await f.service.drain(); f.input('om_question'); await f.start(); f.commitInput(); f.commit(); await f.service.drain();
    const effect = f.read().effects.find(e => e.kind === 'reply')!;
    const post = im.sent.find(s => s.id === effect.messageId)!;
    expect(post.kind).toBe('interactive'); expect(post.destination).toBe(f.read().anchors.cardMessageId);
    const card = JSON.parse(post.content);
    expect(card.body.elements[0].tag).toBe('markdown');
    expect(top(post.content)).toContain('**暂未得出明确结论**');
    expect(top(post.content)).toContain('继续在本话题沟通');
    expect(card.body.elements.at(-1).content).toContain('Which test environment?');
    expect(f.read().application).toBeUndefined();
  });
  it('updates the same reply only after native input and actual summary delivery, including recovery', async () => {
    const f = fixture(); const im = transport(); Object.assign(f.deps, conversationLarkIO(im.client));
    f.create(); await f.service.drain(); f.input('om_decision', 'Use the CLI, test environment only'); await f.start();
    const turn = f.commitInput(); f.commit(f.resolution()); await f.service.drain();
    const reply = f.read().effects.find(e => e.kind === 'reply')!;
    const body = () => im.cards.get(reply.messageId!)!;
    expect(top(body())).toContain('**已形成明确、可执行的决定**');
    expect(top(body())).toContain('等待继续处理'); expect(top(body())).toContain('当前无需继续回复');
    expect(body()).toContain('test environment only'); expect(top(body())).not.toContain('已同步至主流程');
    f.terminal.set(turn.triggerId!, 'completed'); f.service.tick('cli_bot'); await f.service.drain();
    expect(top(body())).not.toContain('正在按结论继续处理');
    const a = f.read().application!;
    f.service.onInputCommitted('cli_bot', 'session', a.triggerId!, 'native:apply'); await f.service.drain();
    expect(top(body())).toContain('正在按结论继续处理'); expect(top(body())).not.toContain('已同步至主流程');
    f.service.applied(f.identity, { applicationKey: a.key, resultRef: `trigger:${a.triggerId}` }, a.triggerId!);
    im.failSummary(true); f.terminal.set(a.triggerId!, 'completed'); f.service.tick('cli_bot'); await f.service.drain();
    expect(top(body())).toContain('主流程通知尚未送达'); expect(top(body())).not.toContain('已同步至主流程');
    im.failSummary(false); f.advance(5000);
    const restored = new AskConversationService({ ...f.deps, store: createConversationStore(f.dir), ...conversationLarkIO(im.client) });
    restored.tick('cli_bot'); await restored.drain();
    const summary = f.read().effects.find(e => e.kind === 'summary')!;
    expect(top(body())).toContain('**结论已同步至主流程**'); expect(top(body())).toContain(summary.messageId);
    expect(top(body())).toContain('后续阶段进展以主流程通知为准');
    restored.tick('cli_bot'); await restored.drain();
    expect(im.sent.filter(s => s.id === reply.messageId)).toHaveLength(1);
    expect(im.sent.filter(s => s.kind === 'text')).toHaveLength(1);
    expect(f.requests).toHaveLength(2);
  });
  it.each([
    ['decline', '不继续执行'], ['defer', '暂缓执行'], ['cancel', '取消执行'],
    ['resolved_externally', '先核验外部处理结果'],
  ] as const)('does not present %s as approval to continue', async (outcome, expected) => {
    const f = fixture(); f.create(); await f.service.drain(); f.input('om_decision'); await f.start(); f.commitInput();
    f.commit(f.resolution(outcome)); await f.service.drain();
    const reply = f.read().effects.find(e => e.kind === 'reply')!;
    const content = top(buildConversationReplyCard(f.read(), reply));
    expect(content).toContain(`**已形成明确结论：${expected}**`);
    expect(content).not.toContain('可执行的决定'); expect(content).not.toContain('已同步至主流程');
    if (outcome === 'resolved_externally') expect(content).not.toContain('已核验');
    else expect(content).toContain('不会按原方案继续推进');
  });
  it('a correction cannot leave the previous reply telling the user the old decision will proceed', async () => {
    const f = fixture(); const im = transport(); Object.assign(f.deps, conversationLarkIO(im.client));
    f.create(); await f.service.drain(); f.input('om_decision'); await f.start(); f.commitInput(); f.commit(f.resolution()); await f.service.drain();
    const reply = f.read().effects.find(e => e.kind === 'reply')!;
    const original = f.read().responses[0].text;
    f.input('om_correction', 'Wait, do not change the environment'); await f.service.drain();
    const content = im.cards.get(reply.messageId!)!;
    expect(top(content)).toContain('**已收到新的补充，结论待重新核对**');
    expect(top(content)).not.toContain('当前无需继续回复'); expect(top(content)).not.toContain('已同步至主流程');
    expect(content).toContain(original); expect(f.read().application).toBeUndefined();
  });
  it('failure to patch the root card does not prevent the substantive reply from updating', async () => {
    const f = fixture(); const im = transport();
    f.create(); await f.service.drain(); f.input('om_question'); await f.start(); f.commitInput(); f.commit(); await f.service.drain();
    const p = f.read(); const reply = p.effects.find(e => e.kind === 'reply')!;
    const update = im.client.updateMessage;
    im.client.updateMessage = async (app, id, content) => {
      if (id === p.anchors.cardMessageId) throw new Error('root card unavailable');
      return update(app, id, content);
    };
    await expect(conversationLarkIO(im.client).patch(p)).rejects.toThrow(/presentation_unconfirmed/);
    expect(top(im.cards.get(reply.messageId!)!)).toContain('**暂未得出明确结论**');
  });
});

it('R7 C11 corrections use the original session queue once while an application is busy', async () => {
  const f = fixture(); f.create(); await f.service.drain(); f.input('om_choice'); await f.start();
  const discussion = f.commitInput(); f.commit(f.resolution()); await f.service.drain();
  f.terminal.set(discussion.triggerId!, 'completed'); f.service.tick('cli_bot'); await f.service.drain();
  const application = f.read().application!;
  f.service.onInputCommitted('cli_bot', 'session', application.triggerId!, 'native:application');
  f.setBusy(true);
  f.input('om_correct', 'Only inspect; do not change the environment'); await f.service.drain();
  const corrections = f.requests.filter(r => r.envelope.payload.purpose === 'correction');
  expect(corrections).toHaveLength(1);
  expect(corrections[0].target).toEqual({ kind: 'turn', botId: 'cli_bot', sessionId: 'session' });
  expect(corrections[0].envelope.payload.applicationTriggerId).toBe(application.triggerId);
  expect(f.read().application!.key).toBe(application.key);
  expect(f.read().lifecycle).toBe('open'); expect(f.read().nextActor).toBe('agent');
  f.input('om_correct', 'Only inspect; do not change the environment'); f.service.tick('cli_bot'); await f.service.drain();
  expect(f.requests.filter(r => r.envelope.payload.purpose === 'correction')).toHaveLength(1);
});

it('R7 C09/C13 Project needs-you state requires a delivered answerable Ask and follows newer input', async () => {
  const { conversationProjectAction } = await import('../src/services/conversation-project-action.js');
  const f = fixture(); f.create();
  const project: any = { chatId: 'oc_chat', status: 'active' };
  expect((conversationProjectAction(f.read(), project) as any).userAction.state).toBe('preparing');
  await f.service.drain();
  expect((conversationProjectAction(f.read(), project) as any).userAction.state).toBe('pending');
  f.input('om_reply');
  expect((conversationProjectAction(f.read(), project) as any).userAction.state).toBe('processing');
  project.userAction = { requestId: 'another-question' };
  expect(conversationProjectAction(f.read(), project)).toBeUndefined();
});

it('a queued correction settles the old application, then discusses new input without replaying it', async () => {
  const f = fixture(); f.create(); await f.service.drain(); f.input('om_first'); await f.start();
  const first = f.commitInput(); f.commit(f.resolution()); await f.service.drain();
  f.terminal.set(first.triggerId!, 'completed'); f.service.tick('cli_bot'); await f.service.drain();
  const application = f.read().application!;
  f.service.onInputCommitted('cli_bot', 'session', application.triggerId!, 'native:application');
  f.service.applied(f.identity, { applicationKey: application.key, resultRef: `trigger:${application.triggerId}` }, application.triggerId!);
  f.setBusy(true); f.input('om_later', 'Only inspect the existing result'); await f.service.drain();
  const correction = f.read().turns.at(-1)!;
  f.terminal.set(application.triggerId!, 'completed');
  f.service.tick('cli_bot'); await f.service.drain();
  expect(f.read().consumedThrough).toBe(1);
  f.service.onInputCommitted('cli_bot', 'session', correction.triggerId!, 'native:correction');
  f.terminal.set(correction.triggerId!, 'completed'); f.setBusy(false);
  f.service.tick('cli_bot'); await f.service.drain();
  expect(f.read().application!.state).toBe('applied');
  const discussion = f.commitInput();
  expect(discussion.purpose).toBeUndefined(); expect(discussion.from).toBe(2);
  f.commit(); f.terminal.set(discussion.triggerId!, 'completed');
  f.service.tick('cli_bot'); await f.service.drain();
  expect(f.read().consumedThrough).toBe(2); expect(f.read().nextActor).toBe('human');
  expect(f.requests.filter(r => r.source.requestId === application.request!.source.requestId)).toHaveLength(1);
  expect(f.requests.filter(r => r.envelope.payload.purpose === 'correction')).toHaveLength(1);
});
