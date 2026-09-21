/** A deleted source topic cannot be escaped with --top-level or --chat-id. */
export async function assertSendTopicsAvailable(
  appId: string,
  roots: readonly (string | undefined | null)[],
  getMessage: (appId: string, messageId: string) => Promise<{ items?: { message_id?: string; deleted?: boolean }[] }>,
): Promise<void> {
  for (const root of new Set(roots.filter((id): id is string => !!id))) {
    let detail;
    try {
      detail = await getMessage(appId, root);
    } catch {
      throw new Error(`TOPIC_SEND_BLOCKED: 无法确认原话题 ${root} 仍存在，停止发送。不要改发顶层、跨群或新建话题。`);
    }
    const message = detail?.items?.find(item => item.message_id === root);
    if (!message || message.deleted !== false) {
      throw new Error(`TOPIC_SEND_BLOCKED: 原话题 ${root} 已撤回、不存在或状态不可确认，停止发送。不要重试或改发顶层、跨群、新话题。`);
    }
  }
}
