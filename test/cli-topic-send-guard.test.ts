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
    })()).rejects.toThrow('TOPIC_SEND_BLOCKED');
    expect(send).not.toHaveBeenCalled();
  });
  it('fails closed on API errors', async () => {
    await expect(assertSendTopicsAvailable('app', ['root'], async () => {
      throw new Error('network or missing message');
    })).rejects.toThrow('TOPIC_SEND_BLOCKED');
  });
  it('leaves unthreaded broadcasts alone', async () => {
    const get = vi.fn();
    await assertSendTopicsAvailable('app', [undefined, null], get);
    expect(get).not.toHaveBeenCalled();
  });
});
