import { describe, expect, it, vi } from 'vitest';
import { authorizeManagedAsk, parseAskLookup } from '../src/core/managed-ask-api.js';
import { lookupAskForOwner } from '../src/dashboard/managed-asks.js';
import { validateTriggerRequest } from '../src/services/trigger-types.js';
import { readManagedAskArgsFromArgv, managedAskRootFromEnv } from '../src/core/managed-ask-args.js';

const identity = { larkAppId: 'app', chatId: 'chat', rootMessageId: null, sessionId: 'session', originKind: 'explicit', requestId: 'req' };
const session = { ...identity, liveOrigin: { capability: 'real-capability', turnId: 'turn', dispatchAttempt: 1 } };
const raw = { ...identity, originCapability: 'real-capability', originTurnId: 'turn', originDispatchAttempt: 1 };
const request = { identity, raw, session, selfAppId: 'app', trustedHost: false, registration: true };

describe('managed Ask authentication', () => {
  it('rejects missing/duplicate managed flags rather than silently sending an ordinary Ask', () => {
    for (const args of [
      ['--request-id'], ['--request-id', '--options', 'yes,no'],
      ['--delivery-context-file'], ['--request-id=a', '--request-id=b'],
    ]) expect(() => readManagedAskArgsFromArgv(args)).toThrow();
    expect(readManagedAskArgsFromArgv([])).toEqual({});
  });
  it('binds a registration to the authenticated live turn', () => {
    expect(authorizeManagedAsk(request)).toEqual({ turnId: 'turn', dispatchAttempt: 1 });
  });
  it('rejects stale capability, attempts, cross-app/session/chat/root and receivers', () => {
    for (const changed of [
      { raw: { ...raw, originCapability: 'stale' } },
      { raw: { ...raw, originDispatchAttempt: 2 } },
      { identity: { ...identity, larkAppId: 'other' } },
      { identity: { ...identity, sessionId: 'other' } },
      { identity: { ...identity, chatId: 'other' } },
      { identity: { ...identity, rootMessageId: 'other' } },
      { session: { ...session, receiver: true } },
      { selfAppId: 'other' },
    ]) expect(() => authorizeManagedAsk({ ...request, ...changed })).toThrow();
  });
  it('host recovery may read a closed session without claiming an old worker capability', () => {
    expect(authorizeManagedAsk({ ...request, trustedHost: true, registration: false, raw: {}, session: { ...identity } })).toBeUndefined();
    expect(() => authorizeManagedAsk({ ...request, registration: false, raw: {}, session: { ...identity } })).toThrow('origin_unproven');
    expect(() => authorizeManagedAsk({ ...request, trustedHost: true, raw: {}, session: { ...identity } })).toThrow('original_turn_unproven');
  });
  it('lookup parser rejects unbounded/missing identity and projects away authority claims', () => {
    expect(() => parseAskLookup({ ...identity, requestId: '' })).toThrow('bad_requestId');
    expect(() => parseAskLookup({ ...identity, originKind: 'a'.repeat(33) })).toThrow('bad_originKind');
    expect(parseAskLookup({ ...identity, trustedHost: true, originCapability: 'secret' })).toEqual(identity);
  });
  it('owner proxy refuses viewers and a conflicting URL session before any daemon call', async () => {
    const proxyToDaemon = vi.fn();
    for (const args of [
      { ownerAuthenticated: false, sessionId: 'session' },
      { ownerAuthenticated: true, sessionId: 'other' },
    ]) expect((await lookupAskForOwner({ ...args, raw, proxyToDaemon })).status).toBe(403);
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });
  it('owner proxy only uses lookup, omits worker credentials and preserves terminal/error semantics', async () => {
    const proxyToDaemon = vi.fn(async () => new Response(JSON.stringify({ state: 'terminal' })));
    expect(await lookupAskForOwner({ ownerAuthenticated: true, sessionId: 'session', raw, proxyToDaemon })).toMatchObject({ status: 200, body: { state: 'terminal' } });
    expect(proxyToDaemon.mock.calls[0].slice(0, 2)).toEqual(['app', '/api/asks/lookup']);
    expect(JSON.parse(proxyToDaemon.mock.calls[0][2].body as string)).toEqual(identity);
    proxyToDaemon.mockRejectedValueOnce(new Error('offline'));
    expect(await lookupAskForOwner({ ownerAuthenticated: true, sessionId: 'session', raw, proxyToDaemon })).toMatchObject({ status: 503, body: { state: 'unknown' } });
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });
});

describe('status-card presentation input contract', () => {
  const trigger = {
    source: { type: 'webhook', connectorId: 'test', requestId: 'req' },
    target: { kind: 'turn', botId: 'app', chatId: 'chat' },
    envelope: { format: 'json', sourceName: 'test', trusted: false, payload: {} },
  };
  it('keeps normal thinking:hidden plus liveCard:on-start valid', () => {
    expect(validateTriggerRequest({ ...trigger, presentation: { thinking: 'hidden', liveCard: 'on-start' } }).ok).toBe(true);
  });
  it('rejects contradictory visible/hidden status cards before dispatch', () => {
    const result = validateTriggerRequest({ ...trigger, presentation: { statusCard: 'hidden', liveCard: 'on-start' } });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
  it('accepts the independent optional policy, rejects invalid policy values', () => {
    expect(validateTriggerRequest({ ...trigger, presentation: { statusCard: 'hidden' } }).ok).toBe(true);
    expect(validateTriggerRequest({ ...trigger, presentation: { statusCard: 'anything' } }).ok).toBe(false);
  });
});


it('normalizes managed chat roots while preserving thread anchors', () => {
  expect(managedAskRootFromEnv({ BOTMUX_SESSION_SCOPE: 'chat', BOTMUX_ROOT_MESSAGE_ID: 'om_trace' })).toBeNull();
  expect(managedAskRootFromEnv({ BOTMUX_SESSION_SCOPE: 'thread', BOTMUX_ROOT_MESSAGE_ID: 'om_thread' })).toBe('om_thread');
  expect(managedAskRootFromEnv({ BOTMUX_ROOT_MESSAGE_ID: 'oc_chat' })).toBeNull();
});
