import { createHash } from 'node:crypto';
import type { TriggerRequest } from '../services/trigger-types.js';

export interface HandoffPreview {
  version: 1;
  source: 'envelope.payload.handoff';
  handoffId: string;
  originalHash: string;
  displayHash: string;
  redacted: boolean;
  text: string;
  capturedAt?: string;
  overflowMessageId?: string;
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export function freezeHandoffPreview(req: TriggerRequest): HandoffPreview | undefined {
  const context = req.presentation?.deliveryContext;
  const payload = req.envelope?.payload as { handoff?: unknown; stage_input?: unknown } | undefined;
  if (!context || typeof payload?.handoff !== 'string') return;
  // Use the actual dispatched business handoff and stage delta, never the
  // system instruction or a dump of historical conversation.
  const original = payload.handoff + (payload.stage_input ? '\n\n当前阶段材料\n' + JSON.stringify(payload.stage_input, null, 2) : '');
  const text = original
    // Unquoted HTTP credentials can contain spaces and semicolon-separated
    // cookies. Redact the whole value before processing individual keys.
    .replace(/\b(authorization|cookie)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\n]+)/gi, '$1: [已脱敏]')
    .replace(/Bearer\s+[\w.+\/-]+/gi, 'Bearer [已脱敏]')
    .replace(/\b(password|passwd|secret|access[_-]?token|refresh[_-]?token|api[_-]?key)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n]+)/gi,
      '$1: [已脱敏]');
  return { version: 1, source: 'envelope.payload.handoff', handoffId: context.handoffId,
    originalHash: sha(original), displayHash: sha(text), redacted: text !== original, text, capturedAt: new Date().toISOString() };
}

export const HANDOFF_INLINE_BYTES = 9000;
export function handoffNeedsAttachment(preview: HandoffPreview): boolean { return Buffer.byteLength(preview.text, 'utf8') > HANDOFF_INLINE_BYTES; }
export function handoffPreviewElements(preview?: HandoffPreview): unknown[] {
  if (!preview) return [{ tag: 'markdown', text_size: 'notation', content: '本次交接正文未留存' }];
  let text = preview.text;
  if (handoffNeedsAttachment(preview)) {
    text = Array.from(text).slice(0, 1500).join('') + (preview.overflowMessageId
      ? '\n\n完整交接内容已发送为本卡下的交接附件。' : '\n\n完整交接附件正在发送；全文已保存在本次交接记录。');
  }
  // Escape Lark markup so handoff text cannot create mentions or fake controls.
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const chunks = Array.from(text).reduce<string[]>((out, char, i) => {
    const index = Math.floor(i / 1500); out[index] = (out[index] ?? '') + char; return out;
  }, []);
  return [{ tag: 'collapsible_panel', expanded: false,
    header: { title: { tag: 'plain_text', content: `交接内容${preview.redacted ? '（已脱敏）' : ''}` } },
    elements: [...chunks.map(content => ({ tag: 'markdown', content })),
      { tag: 'markdown', text_size: 'notation', content: `记录版本：${preview.displayHash.slice(0, 12)} · ${preview.capturedAt ?? '时间未留存'}` }] }];
}

export function withHandoffPreview(cardJson: string, preview?: HandoffPreview): string {
  if (!preview) return cardJson;
  const card = JSON.parse(cardJson);
  // Current terminal cards may use schema 1; native collapsible_panel requires
  // schema 2. Preserve header/config while converting its body shape.
  if (!card.body) {
    card.body = { elements: (card.elements ?? []).map((element: any) => {
      if (element.tag === 'action') return { tag: 'column_set', flex_mode: 'none', columns: element.actions.map((action: unknown) =>
        ({ tag: 'column', width: 'auto', elements: [action] })) };
      if (element.tag === 'note') return { tag: 'markdown', text_size: 'notation', content: element.elements.map((child: any) => child.content ?? '').join('\n') };
      return element;
    }) };
    delete card.elements; card.schema = '2.0';
  }
  card.body.elements.push(...handoffPreviewElements(preview));
  return JSON.stringify(card);
}
