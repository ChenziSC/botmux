import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { askKeyFor } from './ask-persist-store.js';
import { conversationError, parseConversationQuestions, isText, type AskConversation } from './ask-conversation-types.js';

export const conversationDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const conversationKey = (identity: AskConversation['identity']) =>
  askKeyFor(identity.larkAppId, identity.sessionId, identity.originKind, identity.requestId);
export interface ConversationStore {
  get(key: string): AskConversation | undefined;
  scan(): AskConversation[];
  create(record: AskConversation): AskConversation;
  update(key: string, change: (record: AskConversation) => void, expectedVersion?: number): AskConversation;
}
function validate(p: AskConversation) {
  if (!p || p.v !== 4 || p.mode !== 'conversation' || !p.identity
    || !['larkAppId', 'chatId', 'sessionId', 'requestId', 'originKind', 'policyKey', 'subjectRef', 'subjectRevision']
      .every(k => isText(p.identity[k as keyof typeof p.identity], k === 'subjectRef' ? 16000 : 200))
    || p.identity.originKind !== 'explicit'
    || (p.identity.rootMessageId !== null && !isText(p.identity.rootMessageId, 200))
    || p.askKey !== conversationKey(p.identity) || !Number.isSafeInteger(p.stateVersion) || p.stateVersion < 1
    || !isText(p.title, 200) || !isText(p.originalTurnId, 200) || !Number.isFinite(p.createdAt)
    || !['open', 'resolved', 'applied', 'cancelled', 'superseded'].includes(p.lifecycle)
    || !['human', 'agent', 'none'].includes(p.nextActor)
    || !p.owner || !Number.isSafeInteger(p.owner.generation) || p.owner.generation < 1
    || p.owner.communicationActor !== p.identity.larkAppId
    || !Array.isArray(p.owner.decisionPrincipals) || !p.owner.decisionPrincipals.length
    || p.owner.decisionPrincipals.some(id => !isText(id, 200))
    || !p.question || !Number.isSafeInteger(p.question.revision) || p.question.revision < 1
    || p.question.digest !== conversationDigest(parseConversationQuestions(p.question.snapshot))
    || !Array.isArray(p.inbox) || !Number.isSafeInteger(p.consumedThrough) || p.consumedThrough < 0
    || p.consumedThrough > p.inbox.length || !Array.isArray(p.effects) || !Array.isArray(p.turns)
    || !Array.isArray(p.responses) || !Array.isArray(p.resolutions) || !Array.isArray(p.questionHistory)
    || !p.anchors || !Array.isArray(p.anchors.replyIds) || !p.waiting || !Number.isFinite(p.waiting.dueAt)) {
    conversationError('invalid_record', 503);
  }
  if (p.inbox.some((e, i) => e.seq !== i + 1 || !isText(e.id, 200) || !isText(e.by, 200)
    || !Number.isFinite(e.receivedAt) || typeof e.text !== 'string' || !Array.isArray(e.attachments))
    || new Set(p.inbox.map(e => e.id)).size !== p.inbox.length) conversationError('invalid_inbox', 503);
  // Bound the full durable record. Reject before acknowledging; never truncate input.
  if (Buffer.byteLength(JSON.stringify(p)) > 4 * 1024 * 1024) conversationError('storage_limit', 413);
}
/** Separate directory protects v4 from v2/v3 retention and rollback GC.
 * No read creates files, expires answers, acquires ownership or starts work. */
export function createConversationStore(asksDir: string): ConversationStore {
  const dir = join(asksDir, 'managed-v4');
  const file = (key: string) => join(dir, conversationDigest(key) + '.json');
  const get = (key: string) => {
    let p: AskConversation;
    try { p = JSON.parse(readFileSync(file(key), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; return conversationError('unreadable_record', 503); }
    validate(p);
    if (p.askKey !== key) conversationError('identity_conflict', 403);
    return p;
  };
  const locked = <T>(key: string, fn: () => T) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return withFileLockSync(file(key), fn, { maxWaitMs: 100 });
  };
  const write = (p: AskConversation) => {
    validate(p);
    atomicWriteFileSync(file(p.askKey), JSON.stringify(p), { mode: 0o600, durable: true, followTargetSymlink: false });
  };
  return {
    get,
    scan() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => {
        const raw = JSON.parse(readFileSync(join(dir, n), 'utf8')) as AskConversation;
        validate(raw);
        if (file(raw.askKey) !== join(dir, n)) conversationError('identity_conflict', 503);
        return raw;
      });
    },
    create(p) {
      return locked(p.askKey, () => {
        const existing = get(p.askKey);
        if (existing) {
          if (conversationDigest(existing.identity) !== conversationDigest(p.identity)
            || existing.question.digest !== p.question.digest || existing.originalTurnId !== p.originalTurnId)
            conversationError('create_conflict');
          return existing;
        }
        write(p); return p;
      });
    },
    update(key, change, expectedVersion) {
      return locked(key, () => {
        const prior = get(key);
        if (!prior) return conversationError('not_found', 404);
        if (expectedVersion !== undefined && expectedVersion !== prior.stateVersion) conversationError('version_conflict');
        const next = structuredClone(prior); change(next);
        if (conversationDigest(next.identity) !== conversationDigest(prior.identity)
          || next.originalTurnId !== prior.originalTurnId || next.askKey !== prior.askKey
          || next.inbox.length < prior.inbox.length || next.consumedThrough < prior.consumedThrough
          || conversationDigest(next.inbox.slice(0, prior.inbox.length)) !== conversationDigest(prior.inbox))
          conversationError('immutable_history_conflict');
        if (JSON.stringify(next) === JSON.stringify(prior)) return prior;
        next.stateVersion = prior.stateVersion + 1;
        write(next); return next;
      });
    },
  };
}
