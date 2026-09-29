import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIpcServer, setLarkAppId, setIpcAuthSecret } from '../src/core/dashboard-ipc-server.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { createInputCaptureStore } from '../src/core/plugins/input-capture/store.js';
import { createInputCaptureRuntime, setInputCaptureRuntime } from '../src/core/plugins/input-capture/runtime.js';
import { captureInboundText } from '../src/im/lark/input-capture.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'capture-ipc-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = createInputCaptureStore(dir, 'cli_capture');
  const runtime = createInputCaptureRuntime({ larkAppId: 'cli_capture', store,
    session: id => id === 's' ? { sessionId: 's', larkAppId: 'cli_capture', chatId: 'oc_chat', anchor: 'oc_chat', ownerOpenId: 'ou_owner', active: true } : undefined,
    pluginEnabled: id => id === 'example', canTalk: () => true, deliver: async () => { throw new Error('offline'); } });
  cleanup.push(() => runtime.stop()); return { runtime, store };
}
it('requires real host HMAC before register and keeps query / revoke bound to the source session', async () => {
  const f = setup(); setInputCaptureRuntime('cli_capture', f.runtime); setLarkAppId('cli_capture'); setIpcAuthSecret('capture-test-secret');
  const server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true }); cleanup.push(() => server.close());
  const path = '/api/sessions/s/input-capture';
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ larkAppId: 'cli_capture', operation: 'register', pluginId: 'example', requestId: 'r', providerRef: 'opaque', inputAnchor: 'om_card' }) };
  expect((await fetch(`http://127.0.0.1:${server.port}${path}`, init)).status).toBe(401);
  expect(f.store.read().bindings).toEqual([]);
  const registered = await fetchDaemonIpc(server.port, path, init, 'capture-test-secret'); expect(registered.status).toBe(200);
  const body = await registered.json(); expect(body.result).toMatchObject({ anchor: 'om_card', sourceAnchor: 'oc_chat' });
  const inspect = { ...init, body: JSON.stringify({ larkAppId: 'cli_capture', operation: 'inspect', bindingId: body.result.id }) };
  expect((await fetchDaemonIpc(server.port, '/api/sessions/other/input-capture', inspect, 'capture-test-secret')).status).toBe(404);
  const revoked = await fetchDaemonIpc(server.port, path, { ...init, body: JSON.stringify({ larkAppId: 'cli_capture', operation: 'revoke', bindingId: body.result.id, expectedRevision: 1 }) }, 'capture-test-secret');
  expect((await revoked.json()).result.active).toBe(false);
});
it('captures a plugin card reply synchronously while preserving commands, attachments and other topics', async () => {
  const f = setup(); f.runtime.register('s', { pluginId: 'example', requestId: 'r', providerRef: 'opaque', inputAnchor: 'om_card' });
  const event = (text: string, patch = {}) => ({ sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: { message_id: 'om_reply', chat_id: 'oc_chat', chat_type: 'group', root_id: 'om_card', message_type: 'text', content: JSON.stringify({ text }), ...patch } });
  for (const text of ['/stop', '/workflow new inspect']) expect(captureInboundText(event(text), f.runtime, () => false)).toBe(false);
  expect(captureInboundText(event('file', { message_type: 'file', content: JSON.stringify({ file_key: 'f', file_name: 'input.txt' }) }), f.runtime, () => false)).toBe(false);
  expect(captureInboundText(event('other', { root_id: 'om_other' }), f.runtime, () => false)).toBe(false);
  expect(captureInboundText(event('inspect only'), f.runtime, () => false)).toBe(true);
  // No await between the production ingress handler and this disk read.
  expect(f.store.read().inputs[0].text).toBe('inspect only');
  await f.runtime.drain(); f.runtime.revoke('s', f.store.read().bindings[0].id, 1);
  expect(captureInboundText(event('inspect only'), f.runtime, () => false)).toBe(true);
  expect(f.store.read().inputs).toHaveLength(1);
});
