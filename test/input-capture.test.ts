import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInputCaptureStore } from '../src/core/plugins/input-capture/store.js';
import { createInputCaptureRuntime, type InputCaptureOptions } from '../src/core/plugins/input-capture/runtime.js';
import { parseInputCaptureCommand } from '../src/cli/input-capture.js';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture(overrides: Partial<InputCaptureOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = createInputCaptureStore(dir, 'cli_example');
  const session = { sessionId: 's', larkAppId: 'cli_example', chatId: 'oc_chat', anchor: 'om_root', ownerOpenId: 'ou_owner', active: true };
  const options: InputCaptureOptions = { larkAppId: 'cli_example', store, session: () => session,
    pluginEnabled: p => p === 'example', canTalk: () => true,
    deliver: async () => { throw new Error('offline'); }, ...overrides };
  const runtime = createInputCaptureRuntime(options); cleanups.push(() => runtime.stop());
  const binding = runtime.register('s', { pluginId: 'example', requestId: 'request', providerRef: 'opaque' });
  const event = { messageId: 'om_reply', chatId: 'oc_chat', anchor: 'om_root', senderOpenId: 'ou_owner', text: 'continue only the first step', botSender: false };
  return { runtime, binding, event, options, store, session };
}
describe('exact plugin input capture', () => {
  it('commits before acknowledging and preserves the original input across outage and restart', async () => {
    const f = fixture(); expect(f.runtime.capture(f.event)).toBe(true); await f.runtime.drain(); await f.runtime.stop();
    const saved = f.store.read(); expect(saved.inputs[0].delivery).toBe('pending');
    const received: string[] = [];
    const resumed = createInputCaptureRuntime({ ...f.options, deliver: async (_binding, input) => { received.push(input.text); } });
    cleanups.push(() => resumed.stop()); await resumed.drain();
    expect(received).toEqual([f.event.text]); expect(f.store.read().inputs[0].delivery).toBe('acknowledged');
    expect(resumed.capture(f.event)).toBe(true); await resumed.drain(); expect(received).toHaveLength(1);
  });
  it('keeps ordered delivery and idempotent input ids after a lost receiver acknowledgement', async () => {
    const delivered = new Set<string>(); let loseAck = true;
    const f = fixture({ deliver: async (_binding, input) => { delivered.add(input.id); if (loseAck) throw new Error('lost ack'); } });
    f.runtime.capture(f.event); f.runtime.capture({ ...f.event, messageId: 'om_second', text: 'correction: inspect only' });
    await f.runtime.drain(); expect(delivered.size).toBe(1); loseAck = false;
    await f.runtime.drain(); expect(delivered.size).toBe(2);
    expect(f.store.read().inputs.map(i => i.delivery)).toEqual(['acknowledged', 'acknowledged']);
  });
  it('does not capture another actor, anchor, chat or a bot and never falls through after the session becomes inactive', () => {
    const f = fixture();
    for (const patch of [{ senderOpenId: 'ou_other' }, { anchor: 'om_other' }, { chatId: 'oc_other' }, { botSender: true }]) {
      expect(f.runtime.capture({ ...f.event, ...patch })).toBe(false);
    }
    f.session.active = false;
    expect(() => f.runtime.capture(f.event)).toThrow('authority_changed'); expect(f.store.read().inputs).toEqual([]);
  });
  it('checks current talk permission on each new input while retaining previously accepted evidence', async () => {
    let canTalk = true;
    const f = fixture({ canTalk: () => canTalk });
    expect(f.runtime.capture(f.event)).toBe(true); await f.runtime.drain();
    canTalk = false;
    expect(() => f.runtime.capture({ ...f.event, messageId: 'om_after_revoke' })).toThrow('authority_changed');
    expect(() => f.runtime.register('s', { pluginId: 'example', requestId: 'second', providerRef: 'opaque' })).toThrow('session_unavailable');
    expect(f.runtime.capture(f.event)).toBe(true);
    expect(f.store.read().inputs).toHaveLength(1);
  });
  it('retains accepted input on revoke and rejects conflicting bindings and stale revisions', async () => {
    const f = fixture(); f.runtime.capture(f.event); await f.runtime.drain();
    expect(() => f.runtime.register('s', { pluginId: 'example', requestId: 'another', providerRef: 'x' })).toThrow('anchor_conflict');
    expect(() => f.runtime.revoke('s', f.binding.id, 9)).toThrow('revision_conflict');
    f.runtime.revoke('s', f.binding.id, 1);
    expect(f.runtime.capture({ ...f.event, messageId: 'om_later' })).toBe(false);
    expect(f.runtime.inspect('s', f.binding.id)?.inputs).toHaveLength(1);
    expect(f.runtime.register('s', { pluginId: 'example', requestId: 'request', providerRef: 'opaque' }).active).toBe(false);
  });
  it('does not confirm input when persistence fails and does not rewrite acknowledged messages', async () => {
    const f = fixture(); const transact = f.store.transact;
    f.store.transact = () => { throw new Error('disk unavailable'); };
    expect(() => f.runtime.capture(f.event)).toThrow('disk unavailable'); f.store.transact = transact;
    expect(f.store.read().inputs).toEqual([]);
    f.runtime.capture(f.event); await f.runtime.drain();
    expect(() => f.runtime.capture({ ...f.event, text: 'different' })).toThrow('message_conflict');
    expect(f.store.read().inputs[0].text).toBe(f.event.text);
  });
  it('parses explicit host identities and rejects missing, duplicate and unsafe flags', () => {
    const command = parseInputCaptureCommand(['register', '--bot', 'cli_example', '--session', 's', '--plugin', 'example', '--request', 'r', '--ref', 'opaque']);
    expect(JSON.parse(command.init.body).operation).toBe('register');
    expect(() => parseInputCaptureCommand(['register', '--bot', 'cli_example'])).toThrow();
    expect(() => parseInputCaptureCommand(['revoke', '--bot', 'cli_example', '--session', 's', '--binding', 'id', '--revision', 'NaN'])).toThrow();
  });
});
