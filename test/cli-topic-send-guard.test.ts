import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { assertSendTopicsAvailable } from '../src/cli/topic-send-guard.js';
describe('topic send guard', () => {
  it('allows a live topic and deduplicates source/target', async () => {
    const get = vi.fn(async () => ({items: [{message_id: 'root', deleted: false}]}));
    await assertSendTopicsAvailable('app', ['root', 'root'], get);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it.each([
    {items: [{message_id: 'root', deleted: true}]},
    {items: []},
    {items: [{message_id: 'different', deleted: false}]},
    {items: [{message_id: 'root'}]},
  ])('blocks unavailable roots before any send', async detail => {
    const send = vi.fn();
    await expect((async () => {
      await assertSendTopicsAvailable('app', ['root'], async () => detail);
      send();
    })()).rejects.toThrow(detail.items[0]?.deleted === true ? 'TOPIC_SEND_BLOCKED' : 'TOPIC_SEND_CHECK_FAILED');
    expect(send).not.toHaveBeenCalled();
  });
  it('fails closed on API errors', async () => {
    await expect(assertSendTopicsAvailable('app', ['root'], async () => {
      throw new Error('Bot not registered: app');
    })).rejects.toMatchObject({
      message: expect.stringContaining('TOPIC_SEND_CHECK_FAILED'),
      cause: expect.objectContaining({ message: 'Bot not registered: app' }),
    });
  });
  it('registers configured and environment-pinned clients before the first CLI topic query', () => {
    const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const guard = source.indexOf('const { getMessageDetail: getTopicMessageDetail }');
    const registration = source.lastIndexOf('for (const cfg of loadBotConfigs()) registerBot(cfg)', guard);
    const pinned = source.indexOf('registerBot(envPinnedRiffBot)', registration);
    const check = source.indexOf('await checkSendTopics()', guard);
    expect(registration).toBeGreaterThan(source.lastIndexOf('const appId = s.larkAppId!', guard));
    expect(pinned).toBeLessThan(guard);
    expect(guard).toBeLessThan(check);
  });
  it('leaves unthreaded broadcasts alone', async () => {
    const get = vi.fn();
    await assertSendTopicsAvailable('app', [undefined, null], get);
    expect(get).not.toHaveBeenCalled();
  });
});
