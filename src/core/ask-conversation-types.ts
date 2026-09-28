import type { AskLookupIdentity } from './ask-broker.js';
import type { TriggerRequest } from '../services/trigger-types.js';
import { ManagedAskError } from './managed-ask-types.js';

export type ConversationIdentity = AskLookupIdentity & {
  policyKey: string; subjectRef: string; subjectRevision: string;
};
export interface ConversationQuestion {
  id: string; prompt: string; multiSelect: boolean;
  options: Array<{ key: string; label: string }>;
}
export interface ConversationInput {
  seq: number; id: string; by: string; receivedAt: number; questionRevision: number;
  text: string; attachments: Array<{ messageId: string; type: string; key: string }>;
  answers?: Array<{ questionId: string; keys: string[] }>;
}
export interface ConversationResolution {
  revision: number; basisThrough: number; questionRevision: number; subjectRevision: string;
  ownerGeneration: number; sourceInputIds: string[];
  outcome: 'proceed' | 'decline' | 'defer' | 'cancel' | 'resolved_externally';
  summary: string; conditions: string[];
  answers: Array<{ questionId: string; sourceInputIds: string[]; disposition: 'answered' | 'not_applicable' }>;
}
export interface ConversationTurn {
  purpose?: 'correction'; applicationKey?: string;
  key: string; from: number; through: number; ownerGeneration: number;
  state: 'reserved' | 'registered' | 'committed' | 'completed' | 'unknown';
  triggerId?: string; inputCommitRef?: string; request: TriggerRequest;
}
export interface ConversationEffect {
  id: string; kind: 'question' | 'runtime' | 'reply' | 'summary';
  state: 'pending' | 'sent' | 'superseded'; body?: string; messageId?: string;
  through: number; needsInput?: boolean; attempts: number; retryAt?: number; error?: string;
  /** Bind the visible conclusion to an immutable decision, not model prose. */
  resolutionRevision?: number;
}
export interface AskConversation {
  v: 4; askKey: string; mode: 'conversation'; identity: ConversationIdentity;
  title: string; originalTurnId: string; createdAt: number; stateVersion: number;
  question: { revision: number; digest: string; snapshot: ConversationQuestion[] };
  questionHistory: AskConversation['question'][];
  anchors: { cardMessageId?: string; threadId?: string; replyIds: string[] };
  owner: { communicationActor: string; generation: number; decisionPrincipals: string[] };
  lifecycle: 'open' | 'resolved' | 'applied' | 'cancelled' | 'superseded';
  nextActor: 'human' | 'agent' | 'none';
  inbox: ConversationInput[]; consumedThrough: number; turns: ConversationTurn[];
  responses: Array<{ batchId: string; through: number; text: string; effectId: string }>;
  resolutions: ConversationResolution[]; resolution?: ConversationResolution;
  application?: { key: string; resolutionRevision: number;
    state: 'pending' | 'reserved' | 'registered' | 'committed' | 'applied' | 'unknown';
    request?: TriggerRequest; triggerId?: string; inputCommitRef?: string; resultRef?: string };
  effects: ConversationEffect[]; waiting: { since?: number; dueAt: number; timedOutAt?: number };
  selections: Record<string, Record<string, string[]>>;
  selectionVersion?: number; selectionOwner?: string;
  lastError?: string;
}
export type ConversationPolicy = (input: { ask: Readonly<AskConversation>; dataDir: string;
  purpose: 'create' | 'discuss' | 'resolve' | 'apply' | 'result' | 'revise';
  candidate?: Readonly<ConversationResolution>; resultRef?: string;
}) => { state: 'valid' | 'invalid' | 'unknown'; reason: string;
  decisionPrincipals?: string[]; resultVerified?: boolean; resultSummary?: string };

export function conversationError(code: string, status: 400 | 403 | 404 | 409 | 413 | 503 = 409): never {
  throw new ManagedAskError(`ask_conversation_${code}`, status);
}
export function isText(v: unknown, max = 16000): v is string {
  return typeof v === 'string' && !!v.trim() && v.length <= max;
}
export function parseConversationQuestions(raw: unknown): ConversationQuestion[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 12) return conversationError('bad_questions', 400);
  const result = raw.map(q => {
    if (!q || !isText(q.id, 80) || !isText(q.prompt) || typeof q.multiSelect !== 'boolean'
      || !Array.isArray(q.options) || q.options.length > 8) return conversationError('bad_question', 400);
    if (q.options.some((o: any) => !o || !isText(o.key, 80) || !isText(o.label, 120))
      || new Set(q.options.map((o: any) => o.key)).size !== q.options.length) return conversationError('bad_options', 400);
    return { id: q.id, prompt: q.prompt, multiSelect: q.multiSelect,
      options: q.options.map((o: any) => ({ key: o.key, label: o.label })) };
  });
  if (new Set(result.map(q => q.id)).size !== result.length) return conversationError('duplicate_question_id', 400);
  return result;
}
