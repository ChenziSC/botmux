import { conversationDigest } from '../../core/ask-conversation-store.js';
import { conversationError, type AskConversation, type ConversationEffect } from '../../core/ask-conversation-types.js';
import type { AskConversationService } from '../../core/ask-conversation.js';
import { sendMessage, replyMessage, updateMessage, deleteMessage, getMessageDetail } from './client.js';
import { parseEventMessage, stripLeadingMentions } from './message-parser.js';
import { ManagedAskError } from '../../core/managed-ask-types.js';
import { t, localeForBot } from '../../i18n/index.js';

const ACTION = 'ask_conversation_select';
const SUBMIT = 'ask_conversation_submit';
const requiresSubmit = (p: AskConversation) => p.question.snapshot.length > 1 || p.question.snapshot.some(q => q.multiSelect);
export function conversationLabel(p: AskConversation): string {
  if (p.nextActor === 'human') return '需要你';
  if (p.lifecycle === 'applied' || p.lifecycle === 'cancelled') return '阶段结果已记录';
  if (p.lastError) return '执行状态待核实 · 请由任务负责人检查原任务';
  const turn = p.turns.at(-1);
  if (p.application?.inputCommitRef || turn?.inputCommitRef && !p.responses.some(r => r.batchId === turn.key)) return '正在处理你的答复';
  if (p.responses.at(-1)?.through === p.inbox.length) return '本轮执行结束 · 正在核对阶段结果';
  return '已收到答复 · 等待继续处理';
}
export function buildConversationCard(p: AskConversation, runtime = false, confirmEmpty = false) {
  const elements: any[] = [{ tag: 'markdown', content: conversationLabel(p) }];
  const draft = p.selections[p.selectionOwner ?? ''] ?? {};
  const buttonBasis = { askKey: p.askKey, questionRevision: String(p.question.revision),
    basisThrough: String(p.inbox.length), selectionVersion: String(p.selectionVersion ?? 0) };
  if (!runtime) {
    for (const q of p.question.snapshot) {
      elements.push({ tag: 'markdown', content: q.prompt });
      if (p.lifecycle === 'open') for (let i = 0; i < q.options.length; i += 4) {
        elements.push({ tag: 'column_set', flex_mode: 'none', columns: q.options.slice(i, i + 4).map(option => ({
          tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'button',
            text: { tag: 'plain_text', content: requiresSubmit(p)
              ? `${q.multiSelect ? (draft[q.id]?.includes(option.key) ? '☑' : '☐') : (draft[q.id]?.includes(option.key) ? '◉' : '○')} ${option.label}` : option.label },
            type: draft[q.id]?.includes(option.key) ? 'primary' : 'default',
            value: { action: ACTION, ...buttonBasis, questionId: q.id, key: option.key } }],
        })) });
      }
    }
    if (p.lifecycle === 'open' && requiresSubmit(p)) {
      const locale = localeForBot(p.identity.larkAppId);
      if (confirmEmpty) elements.push({ tag: 'markdown', content: t('card.ask.empty_warning', undefined, locale) });
      elements.push({ tag: 'button', type: confirmEmpty ? 'danger' : 'primary',
        text: { tag: 'plain_text', content: t(confirmEmpty ? 'card.ask.submit_confirm_empty' : 'card.ask.submit', undefined, locale) },
        value: { action: SUBMIT, ...buttonBasis, confirmEmpty: confirmEmpty ? 'true' : 'false' } });
    }
    if (p.resolution) elements.push({ tag: 'markdown', content: p.resolution.summary
      + (p.resolution.conditions.length ? '\n' + p.resolution.conditions.join('\n') : '') });
  }
  return JSON.stringify({ schema: '2.0', config: { wide_screen_mode: true },
    header: { template: p.nextActor === 'human' ? 'orange' : 'blue', title: { tag: 'plain_text', content: p.title },
      ...(p.nextActor === 'human' ? { text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: '需要你' }, color: 'orange' }] } : {}) },
    body: { elements } });
}

/** Substantive replies carry a deterministic, bold decision status. Model
 * prose cannot announce delivery; only the exact summary receipt can do so. */
export function buildConversationReplyCard(p: AskConversation, e: ConversationEffect) {
  const resolution = e.needsInput ? undefined : p.resolutions.find(r => e.resolutionRevision !== undefined
    ? r.revision === e.resolutionRevision : r.basisThrough === e.through);
  const current = e.through === p.inbox.length && (!resolution || p.resolution?.revision === resolution.revision);
  const application = resolution && p.application?.resolutionRevision === resolution.revision ? p.application : undefined;
  const summary = resolution && p.effects.find(effect => effect.id === `${p.askKey}:${resolution.revision}:summary`);
  let heading: string;
  let next: string;
  if (!current) {
    heading = '已收到新的补充，结论待重新核对';
    next = '机器人会结合新信息继续处理，以下保留本轮回复供回看。';
  } else if (!resolution) {
    heading = '暂未得出明确结论';
    next = '还需要你继续在本话题沟通，下面说明待确认的问题。';
  } else {
    heading = {
      proceed: '已形成明确、可执行的决定',
      decline: '已形成明确结论：不继续执行',
      defer: '已形成明确结论：暂缓执行',
      cancel: '已形成明确结论：取消执行',
      resolved_externally: application?.state === 'applied' ? '已核验外部处理结果' : '已形成明确结论：先核验外部处理结果',
    }[resolution.outcome];
    if (application?.state === 'applied' && summary?.state === 'sent' && summary.messageId) {
      const link = `https://applink.feishu.cn/client/chat/open?chatId=${encodeURIComponent(p.identity.chatId)}&messageId=${encodeURIComponent(summary.messageId)}`;
      next = `**结论已同步至主流程**。[查看通知](${link})\n当前无需继续回复，后续阶段进展以主流程通知为准。`;
    } else if (application?.state === 'applied') {
      next = '结论已落实，主流程通知尚未送达；当前无需继续回复。';
    } else if (p.lastError) {
      next = '后续处理状态待核实，由机器人处理；当前无需继续回复。';
    } else if (['decline', 'defer', 'cancel'].includes(resolution.outcome)) {
      next = '机器人正在记录这一决定，不会按原方案继续推进；当前无需继续回复。';
    } else if (application?.inputCommitRef) {
      next = '正在按结论继续处理，后续进展将在主流程同步；当前无需继续回复。';
    } else {
      next = '结论已记录，等待继续处理；后续进展将在主流程同步，当前无需继续回复。';
    }
  }
  const elements = [
    { tag: 'markdown', content: `**${heading}**\n\n${next}` },
    ...(resolution ? [{ tag: 'markdown', content: `**结论：**\n${resolution.summary}`
      + (resolution.conditions.length ? `\n\n**执行条件：**\n${resolution.conditions.map(c => `- ${c}`).join('\n')}` : '') }] : []),
    { tag: 'markdown', content: e.body ?? '' },
  ];
  return JSON.stringify({ schema: '2.0', config: { wide_screen_mode: true },
    header: { template: current && !resolution ? 'orange' : 'blue', title: { tag: 'plain_text', content: p.title } },
    body: { elements } });
}

/** UI thread is independent of the session's business routing root. */
export function conversationLarkIO(client = { sendMessage, replyMessage, updateMessage, deleteMessage }) {
  const patched = new Map<string, string>();
  return {
    async send(p: AskConversation, e: ConversationEffect, uuid: string) {
      if (e.kind === 'question') {
        const body = buildConversationCard({ ...p, nextActor: 'human' });
        return p.identity.rootMessageId
          ? client.replyMessage(p.identity.larkAppId, p.identity.rootMessageId, body, 'interactive', true, uuid)
          : client.sendMessage(p.identity.larkAppId, p.identity.chatId, body, 'interactive', uuid);
      }
      if (e.kind === 'summary') {
        const link = `https://applink.feishu.cn/client/chat/open?chatId=${encodeURIComponent(p.identity.chatId)}&messageId=${encodeURIComponent(p.anchors.cardMessageId!)}`;
        const text = `${p.title}\n${e.body}\n${link}`;
        return p.identity.rootMessageId
          ? client.replyMessage(p.identity.larkAppId, p.identity.rootMessageId, text, 'text', true, uuid)
          : client.sendMessage(p.identity.larkAppId, p.identity.chatId, text, 'text', uuid);
      }
      return client.replyMessage(p.identity.larkAppId, p.anchors.cardMessageId!,
        e.kind === 'runtime' ? buildConversationCard(p, true) : buildConversationReplyCard(p, e), 'interactive', true, uuid);
    },
    async patch(p: AskConversation) {
      const targets = [{ id: p.anchors.cardMessageId!, body: buildConversationCard(p) }];
      const runtime = p.effects.filter(e => e.kind === 'runtime' && e.state === 'sent').at(-1);
      if (runtime?.messageId && runtime.through === p.inbox.length) targets.push({ id: runtime.messageId, body: buildConversationCard(p, true) });
      const reply = p.effects.filter(e => e.kind === 'reply' && e.state === 'sent').at(-1);
      if (reply?.messageId) targets.push({ id: reply.messageId, body: buildConversationReplyCard(p, reply) });
      const errors: unknown[] = [];
      for (const target of targets) {
        if (patched.get(target.id) === target.body) continue;
        try { await client.updateMessage(p.identity.larkAppId, target.id, target.body); patched.set(target.id, target.body); }
        catch (error) { errors.push(error); }
      }
      // An unavailable root/runtime card must not hide the actual conclusion
      // delivery in the substantive reply. Failed targets remain retryable.
      if (errors.length) throw new AggregateError(errors, 'ask_conversation_presentation_unconfirmed');
    },
    remove: (p: AskConversation, id: string) => client.deleteMessage(p.identity.larkAppId, id),
  };
}
export async function routeConversationMessage(service: AskConversationService | undefined, data: any, app: string,
  resolveMessage: typeof getMessageDetail = getMessageDetail) {
  if (!service) return false;
  const message = data.message; const sender = data.sender;
  if (!message || !sender?.sender_id?.open_id || !['user', 'human'].includes(sender.sender_type)) return false;
  let p: AskConversation | undefined;
  try { p = service.find(app, message.chat_id, { threadId: message.thread_id, rootId: message.root_id, parentId: message.parent_id }); }
  catch (error) {
    if (!(error instanceof ManagedAskError) || error.code !== 'ask_conversation_ambiguous_anchor'
      || message.root_id || message.parent_id) throw error;
    // Shared topic: resolve this precise message before choosing an Ask.
  }
  if (!p && message.thread_id && !message.root_id && !message.parent_id
    && service.deps.store.scan().some(p => p.identity.larkAppId === app && p.identity.chatId === message.chat_id)) {
    const detail = await resolveMessage(app, message.message_id);
    const original = detail?.items?.find((m: any) => m.message_id === message.message_id);
    if (original?.chat_id === message.chat_id && original.thread_id === message.thread_id)
      p = service.find(app, message.chat_id, { threadId: original.thread_id, rootId: original.root_id, parentId: original.parent_id });
  }
  if (!p) return false;
  const { parsed, resources } = parseEventMessage(data);
  const text = stripLeadingMentions(parsed.content.trim(), message.mentions ?? []).trim();
  if (text.startsWith('/')) return false; // Control commands retain their existing handler.
  if (['cancelled', 'superseded'].includes(p.lifecycle)) return true;
  const attachments = resources.map(r => ({ messageId: r.messageId ?? message.message_id, key: r.key, type: String(r.type) }));
  if (['audio', 'media'].includes(message.message_type)) {
    const body = JSON.parse(message.content);
    if (typeof body.file_key !== 'string' || !body.file_key) conversationError('attachment_reference_missing', 400);
    attachments.push({ messageId: message.message_id, key: body.file_key, type: message.message_type });
  }
  if (message.message_type === 'merge_forward') attachments.push({ messageId: message.message_id, key: message.message_id, type: 'merge_forward' });
  service.ingest(p.askKey, { id: message.message_id, by: sender.sender_id.open_id,
    receivedAt: Number(message.create_time) || Date.now(), text,
    attachments },
  { threadId: message.thread_id });
  return true;
}
export function handleConversationCard(service: AskConversationService | undefined, data: any, app: string,
  canAnswer: (p: AskConversation, by: string) => boolean) {
  const v = data.action?.value;
  if (![ACTION, SUBMIT].includes(v?.action)) return undefined;
  try {
    if (!service || typeof v.askKey !== 'string') conversationError('unavailable');
    const p = service.deps.store.get(v.askKey);
    const by = data.operator?.open_id;
    const messageId = data.context?.open_message_id ?? data.open_message_id;
    if (!p || p.identity.larkAppId !== app || messageId !== p.anchors.cardMessageId
      || !p.owner.decisionPrincipals.includes(by) || !canAnswer(p, by)) conversationError('responder_denied', 403);
    if (p.lifecycle !== 'open' || Number(v.questionRevision) !== p.question.revision
      || Number(v.basisThrough) !== p.inbox.length
      || Number(v.selectionVersion ?? 0) !== (p.selectionVersion ?? 0)) conversationError('stale_button');
    if (v.action === SUBMIT) {
      if (!requiresSubmit(p) || p.selectionOwner && p.selectionOwner !== by) conversationError('draft_not_owned');
      const draft = p.selections[by] ?? {};
      const answers = p.question.snapshot.map(q => ({ questionId: q.id, keys: draft[q.id] ?? [] }));
      if (p.question.snapshot.some((q, i) => !q.multiSelect && answers[i].keys.length !== 1)) conversationError('incomplete_selection');
      if (answers.every(a => !a.keys.length) && v.confirmEmpty !== 'true') {
        return { card: { type: 'raw', data: JSON.parse(buildConversationCard(p, false, true)) } };
      }
      service.ingest(p.askKey, { id: 'button:' + conversationDigest([p.askKey, by, buttonIdentity(p), answers]),
        by, receivedAt: Date.now(), text: p.question.snapshot.map((q, i) =>
          `${q.prompt}\n${answers[i].keys.map(key => q.options.find(o => o.key === key)!.label).join(', ')}`).join('\n\n'),
        attachments: [], answers }, undefined, p.stateVersion);
      return { toast: { type: 'success', content: '已收到答复 · 等待继续处理' } };
    }
    const q = p.question.snapshot.find(q => q.id === v.questionId);
    if (!q || !q.options.some(o => o.key === v.key)) conversationError('bad_option', 400);
    if (requiresSubmit(p)) {
      const saved = service.deps.store.update(p.askKey, current => {
        const draft = current.selections[by] ?? {};
        const keys = draft[q.id] ?? [];
        draft[q.id] = q.multiSelect ? (keys.includes(v.key) ? keys.filter(key => key !== v.key) : [...keys, v.key]) : [v.key];
        current.selections[by] = draft; current.selectionOwner = by;
        current.selectionVersion = (current.selectionVersion ?? 0) + 1;
      }, p.stateVersion);
      service.wake(saved);
      return { card: { type: 'raw', data: JSON.parse(buildConversationCard(saved)) } };
    }
    // One single-choice question keeps the existing immediate-submit path.
    service.ingest(p.askKey, { id: 'button:' + conversationDigest([p.askKey, by, v.questionRevision, v.basisThrough, v.questionId, v.key]),
      by, receivedAt: Date.now(), text: q.options.find(o => o.key === v.key)!.label,
      attachments: [], answers: [{ questionId: q.id, keys: [v.key] }] }, undefined, p.stateVersion);
    return { toast: { type: 'success', content: '已收到答复 · 等待继续处理' } };
  } catch {
    return { toast: { type: 'error', content: '执行状态待核实 · 请由任务负责人检查原任务' } };
  }
}

function buttonIdentity(p: AskConversation) {
  return [p.question.revision, p.inbox.length, p.selectionVersion ?? 0];
}
