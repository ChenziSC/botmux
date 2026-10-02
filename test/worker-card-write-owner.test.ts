import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({ request: vi.fn(), create: vi.fn(), reply: vi.fn(), patch: vi.fn(), upload: vi.fn() }));
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {
  request = mocks.request;
  im = { v1: {
    message: { create: mocks.create, reply: mocks.reply, patch: mocks.patch },
    file: { create: mocks.upload },
    chat: { get: async () => ({ code: 0, data: { chat_mode: 'group' } }) },
  } };
} }));
import {
  initWorkerPool, setActiveSessionsRegistry, getActiveSessionsRegistry,
  postTurnStartingCard, postFreshStreamingCard, __testOnly_setupWorkerHandlers as setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { updateTurnReplyCard } from '../src/core/turn-reply-card.js';
import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import * as sessionStore from '../src/services/session-store.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { __testOnly_activeSessions as activeSessions, __testOnly_sessionReply as sessionReply } from '../src/daemon.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';

const APP = 'cli_worker_card_owner';
const oldDataDir = config.session.dataDir;
const originalRegistry = getActiveSessionsRegistry();
let home: string;
let ds: DaemonSession;
let unavailable: boolean;

beforeEach(() => {
  vi.clearAllMocks(); __testOnly_resetLarkGate();
  vi.stubEnv('BOTMUX_LARK_QPS', '100000');
  vi.stubEnv('BOTMUX_LARK_GATE_RETRY_BASE_MS', '1');
  home = mkdtempSync(join(tmpdir(), 'worker-topic-output-'));
  const data = join(home, 'data'); mkdirSync(data, { mode: 0o700 });
  config.session.dataDir = data;
  unavailable = false;
  activeSessions.clear(); setActiveSessionsRegistry(activeSessions);
  registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
    topicUnavailablePolicy: 'stop', replyCardMode: 'legacy' });
  ds = { larkAppId: APP, chatId: 'oc_source', scope: 'chat', chatType: 'group',
    currentReplyTarget: { turnId: 'turn-new', rootMessageId: 'om_new' },
    session: { sessionId: 'sid_worker_output', larkAppId: APP, chatId: 'oc_source', scope: 'chat',
      rootMessageId: 'om_source', cliId: 'claude-code', status: 'active', title: 'source', workingDir: data },
  } as unknown as DaemonSession;
  sessionStore.init(APP);
  const stored = sessionStore.createSession('oc_source', 'om_source', 'source', 'group', 'chat');
  ds.session = { ...stored, ...ds.session, sessionId: stored.sessionId };
  sessionStore.updateSession(ds.session);
  activeSessions.set(activeSessionKey(ds), ds);
  initWorkerPool({ sessionReply, getSessionWorkingDir: () => data, getActiveCount: () => 1, closeSession: vi.fn() });
  mocks.request.mockReset().mockImplementation(async ({ method, url }) => {
    if (method === 'GET' && url.includes('/im/v1/chats/')) return { code: 0, data: { chat_mode: 'group' } };
    if (method !== 'GET' || !url.includes('/im/v1/messages/')) throw new Error('Unexpected provider request');
    const id = url.split('/').at(-1);
    return { code: 0, data: { items: [{ message_id: id, chat_id: 'oc_source',
      ...(id === 'om_sent' ? { root_id: 'om_source' } : {}), deleted: id === 'om_source' && unavailable }] } };
  });
  mocks.create.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_sent' } });
  mocks.reply.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_sent' } });
  mocks.patch.mockReset().mockResolvedValue({ code: 0 });
  mocks.upload.mockReset().mockResolvedValue({ file_key: 'file_overflow' });
});
afterEach(() => {
  activeSessions.clear(); setActiveSessionsRegistry(originalRegistry);
  ds.session.status = 'closed';
  sessionStore.init(APP, { owner: false });
  config.session.dataDir = oldDataDir;
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs(); __testOnly_resetLarkGate();
});

function cardReply(body: string, type: string, uuid: string, beforeWrite: () => void | Promise<void>) {
  return sessionReply('oc_source', body, type, APP, 'om_turn_old', {
    uuid, beforeWrite, sourceSessionId: ds.session.sessionId,
    replyTarget: { mode: 'thread', rootMessageId: 'om_source' },
  });
}
function cardEvent(kind: 'new-card' | 'overflow') {
  const text = 'large result\n'.repeat(10000);
  return kind === 'new-card'
    ? { kind: 'progress' as const, text: 'Working' }
    : { kind: 'final' as const, text, source: 'bridge' as const,
      card: JSON.stringify({ schema: '2.0', config: {}, body: { elements: [{ tag: 'markdown', content: text }] } }) };
}
function prepareStatusCard() {
  ds.workerReady = true;
  ds.currentReplyTarget = { turnId: 'om_turn_old', rootMessageId: 'om_source' };
  ds.streamCardPending = true;
  ds.streamCardPendingTurnId = 'om_turn_old';
}
const publications = ['starting', 'fresh'] as const;
const replies = ['new-card', 'overflow'] as const;
const timings = ['lookup', 'retry'] as const;

describe('card ownership at the provider write', () => {
  it.each(publications.flatMap(kind => timings.map(timing => [kind, timing] as const)))(
    'does not publish a %s card after its nonce changes during %s', async (kind, timing) => {
    prepareStatusCard();
    if (timing === 'lookup') {
      const read = mocks.request.getMockImplementation()!;
      mocks.request.mockImplementationOnce(async input => {
        const result = await read(input); ds.streamCardNonce = 'replacement'; return result;
      });
    } else {
      mocks.reply.mockImplementationOnce(async () => {
        ds.streamCardNonce = 'replacement'; throw { isAxiosError: true, response: { status: 429 } };
      });
    }
    const result = kind === 'starting'
      ? await postTurnStartingCard(ds, sessionReply, 'om_turn_old')
      : await postFreshStreamingCard(ds, sessionReply);
    expect(result).toBe(false);
    expect(mocks.reply).toHaveBeenCalledTimes(timing === 'lookup' ? 0 : 1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(ds.streamCardNonce).toBe('replacement');
  });

  it.each(replies.flatMap(kind => timings.map(timing => [kind, timing] as const)))(
    'does not send %s after owner loss during %s', async (kind, timing) => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      topicUnavailablePolicy: 'stop', replyCardMode: 'unified' });
    let owns = true;
    if (timing === 'lookup') {
      const read = mocks.request.getMockImplementation()!;
      mocks.request.mockImplementationOnce(async input => { const result = await read(input); owns = false; return result; });
    } else {
      mocks.reply.mockImplementationOnce(async () => {
        owns = false; throw { isAxiosError: true, response: { status: 429 } };
      });
    }
    await expect(updateTurnReplyCard(ds, 'om_turn_old', cardEvent(kind), cardReply,
      { owns: () => owns, forceVisible: true })).rejects.toThrow('no longer owns');
    expect(mocks.reply).toHaveBeenCalledTimes(timing === 'lookup' ? 0 : 1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.upload).toHaveBeenCalledTimes(kind === 'overflow' ? 1 : 0);
  });

  it.each(publications)('publishes an owned %s card at the original target', async kind => {
    prepareStatusCard();
    const result = kind === 'starting'
      ? await postTurnStartingCard(ds, sessionReply, 'om_turn_old')
      : await postFreshStreamingCard(ds, sessionReply);
    expect(result).toBe(true);
    expect(ds.streamCardId).toBe('om_sent');
    expect(mocks.reply).toHaveBeenCalledOnce();
    expect(mocks.reply.mock.calls[0][0]).toMatchObject({ path: { message_id: 'om_source' }, data: { reply_in_thread: true } });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(replies)('publishes an owned %s and preserves the original thread', async kind => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      topicUnavailablePolicy: 'stop', replyCardMode: 'unified' });
    const result = await updateTurnReplyCard(ds, 'om_turn_old', cardEvent(kind), cardReply, { forceVisible: true });
    expect(result?.delivered).toBe(true);
    expect(result?.record.overflowMessageId).toBe(kind === 'overflow' ? 'om_sent' : undefined);
    expect(mocks.upload).toHaveBeenCalledTimes(kind === 'overflow' ? 1 : 0);
    for (const [request] of mocks.reply.mock.calls) expect(request.path.message_id).toBe('om_source');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects a reply card after its session moves even without a worker predicate', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      topicUnavailablePolicy: 'stop', replyCardMode: 'unified' });
    const read = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementationOnce(async input => { const result = await read(input); ds.chatId = 'oc_moved'; return result; });
    await expect(updateTurnReplyCard(ds, 'om_turn_old', cardEvent('new-card'), cardReply,
      { forceVisible: true })).rejects.toThrow('no longer owns');
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('native worker card publication', () => {
  it.each((['ready', 'screen_update'] as const).flatMap(kind =>
    (['lookup', 'retry', 'none'] as const).map(timing => [kind, timing] as const)))(
    'preserves %s publication ownership through %s', async (kind, timing) => {
    prepareStatusCard();
    const worker = Object.assign(new EventEmitter(), {
      killed: false, send: vi.fn(), kill: vi.fn(), pid: 12345,
      stdout: new EventEmitter(), stderr: new EventEmitter(),
    });
    ds.worker = worker as any;
    ds.lastScreenStatus = 'working';
    ds.displayMode = 'hidden';
    const pending: Promise<unknown>[] = [];
    initWorkerPool({ sessionReply: (...args) => {
      const work = sessionReply(...args); pending.push(work); return work;
    }, getSessionWorkingDir: () => ds.session.workingDir!, getActiveCount: () => 1, closeSession: vi.fn() });
    setupWorkerHandlers(ds, worker as any);
    if (timing === 'lookup') {
      const read = mocks.request.getMockImplementation()!;
      mocks.request.mockImplementationOnce(async input => {
        const result = await read(input); ds.streamCardNonce = 'replacement'; return result;
      });
    } else if (timing === 'retry') {
      mocks.reply.mockImplementationOnce(async () => {
        ds.streamCardNonce = 'replacement'; throw { isAxiosError: true, response: { status: 429 } };
      });
    }
    await worker.listeners('message')[0](kind === 'ready'
      ? { type: 'ready', port: 9999, token: 'fixture', turnId: 'om_turn_old' }
      : { type: 'screen_update', content: 'working', status: 'working', turnId: 'om_turn_old' });
    await Promise.allSettled(pending);
    expect(pending).not.toHaveLength(0);
    expect(mocks.reply).toHaveBeenCalledTimes(timing === 'lookup' ? 0 : 1);
    expect(mocks.create).not.toHaveBeenCalled();
    if (timing === 'none') {
      expect(ds.streamCardId).toBe('om_sent');
      expect(mocks.reply.mock.calls[0][0].path.message_id).toBe('om_source');
    } else expect(ds.streamCardNonce).toBe('replacement');
  });
});
