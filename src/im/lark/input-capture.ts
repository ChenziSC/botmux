import { parseEventMessage, stripLeadingMentions } from './message-parser.js';
import { isCallbackUrl } from '../../utils/user-token.js';
import { isTopicHeader, parseTopicHeaderWithLifecycleAliases } from '../../core/topic-header.js';
import type { InputCaptureRuntime } from '../../core/plugins/input-capture/runtime.js';

/** Synchronous pre-ACK path. Only exact raw message anchors enter the journal;
 * command / callback / attachment routing stays with the existing dispatcher. */
export function captureInboundText(data: any, runtime: InputCaptureRuntime,
  knownBot: (openId: string) => boolean): boolean {
  const message = data?.message;
  if (data?.sender?.sender_type !== 'user' || !message || !['text', 'post'].includes(message.message_type)
    || (message.root_id && !/^om_[A-Za-z0-9_-]+$/.test(message.root_id))
    || (message.thread_id && !message.root_id)) return false;
  const { parsed, resources } = parseEventMessage(data);
  if (resources.length || parsed.senderType === 'app' || parsed.senderType === 'bot'
    || !parsed.senderId || knownBot(parsed.senderId)) return false;
  const command = stripLeadingMentions(parsed.content.trim(), parsed.mentions).trim();
  if (!command || command.startsWith('/') || isCallbackUrl(command)
    || isTopicHeader(parseTopicHeaderWithLifecycleAliases(command))) return false;
  return runtime.capture({ messageId: parsed.messageId, chatId: message.chat_id,
    anchor: message.root_id || message.chat_id, senderOpenId: parsed.senderId,
    memberUnionId: parsed.senderUnionId, text: parsed.content, botSender: false });
}
