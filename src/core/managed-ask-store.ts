import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import type { PersistedAsk } from './ask-persist-store.js';
import { askKeyFor } from './ask-persist-store.js';
import type { AskResult } from './ask-types.js';
import {
  ManagedAskError, parseManagedDeliveryContext, validAskOriginalTurn, validAskResult,
  type ManagedDeliveryContextV1, type AskOriginalTurn, type ManagedAskPresentation, type AskContinuation,
} from './managed-ask-types.js';

export interface PersistedManagedAsk extends Omit<PersistedAsk, 'v' | 'answeredResult' | 'answeredAt'> {
  v: 3;
  phase: 'pending' | 'terminal';
  deliveryContext: ManagedDeliveryContextV1;
  originalTurn: AskOriginalTurn;
  terminalResult?: AskResult;
  acceptedAt?: number;
  expiresAt?: number;
  /** GC removes answer text, retaining the minimal non-replay tombstone. */
  resultExpired?: true;
  presentation: ManagedAskPresentation;
  handoffPreview?: import('./handoff-preview.js').HandoffPreview;
  continuation?: AskContinuation;
  execution?: import('./managed-ask-types.js').ManagedAskExecution;
}

export type ManagedAskRead =
  | { found: true; record: PersistedManagedAsk }
  | { found: false; reason: 'not_found' | 'unreadable' | 'unsupported_schema' | 'invalid_record' };

export interface ManagedAskStore {
  readonly dir: string;
  /** Read only. Does not mkdir, GC, claim a waiter, or refresh retention. */
  get(key: string): ManagedAskRead;
  scan(): PersistedManagedAsk[];
  create(record: PersistedManagedAsk): PersistedManagedAsk;
  /** Throws on failure; callers must not acknowledge an answer before this returns. */
  put(record: PersistedManagedAsk): void;
  /** A short, synchronous identity transaction. No network/CLI waiting inside. */
  update(key: string, change: (record: PersistedManagedAsk) => PersistedManagedAsk): PersistedManagedAsk;
  /** Boot/maintenance only; lookup must never call this method. */
  list(now?: number, larkAppId?: string): PersistedManagedAsk[];
  expire(key: string, now?: number): PersistedManagedAsk | undefined;
}

function validRecord(p: PersistedManagedAsk): boolean {
  if (p.v !== 3 || !['pending', 'terminal'].includes(p.phase)
    || !parseManagedDeliveryContext(p.deliveryContext) || !validAskOriginalTurn(p.originalTurn)
    || ![p.askId, p.nonce, p.larkAppId, p.chatId, p.sessionId, p.originKind, p.requestId].every(s => typeof s === 'string' && !!s.trim())
    || (p.rootMessageId !== null && typeof p.rootMessageId !== 'string')
    || p.askKey !== askKeyFor(p.larkAppId, p.sessionId, p.originKind, p.requestId)
    || !Number.isFinite(p.createdAt) || !Number.isFinite(p.deadlineAt)
    || !Array.isArray(p.questions) || !p.questions.length
    || !p.questions.every(q => q && typeof q.prompt === 'string' && typeof q.multiSelect === 'boolean'
      && Array.isArray(q.options) && q.options.length >= 2 && q.options.every((o: { key: unknown; label: unknown }) => o && typeof o.key === 'string' && typeof o.label === 'string'))
    || !p.presentation || !['none', 'pending', 'sent', 'cleanup_pending'].includes(p.presentation.state)
    || !Number.isSafeInteger(p.presentation.revision) || p.presentation.revision < 0
    || (p.presentation.segment !== undefined && (!Number.isSafeInteger(p.presentation.segment) || p.presentation.segment < 1))) return false;
  if (p.originKind !== 'explicit' || (p.originalTurn.dispatchAttempt === undefined && !p.execution)) return false;
  if (p.execution && (typeof p.execution.bootId !== 'string' || !p.execution.bootId
    || typeof p.execution.replayKey !== 'string' || !p.execution.replayKey
    || !['fresh', 'turn'].includes(p.execution.replayKind)
    || !Number.isSafeInteger(p.execution.workerGeneration) || p.execution.workerGeneration < 1
    || (p.execution.terminal && (!['completed', 'failed', 'cancelled', 'ambiguous'].includes(p.execution.terminal.status)
      || !Number.isFinite(p.execution.terminal.observedAt))))) return false;
  if (p.continuation && (!['reserved', 'accepted', 'unknown', 'settled'].includes(p.continuation.state)
    || p.continuation.key !== `${p.requestId}:answered-continuation`
    || !validAskOriginalTurn(p.continuation.originalTurn)
    || p.continuation.originalTurn.turnId !== p.originalTurn.turnId
    || p.continuation.originalTurn.dispatchAttempt !== p.originalTurn.dispatchAttempt)) return false;
  if (p.terminalResult?.kind === 'answered' && (!validAskResult(p.terminalResult)
    || p.terminalResult.answers.length !== p.questions.length
    || !p.terminalResult.answers.every((keys, index) => keys.every(key => p.questions[index].options.some(o => o.key === key))))) return false;
  if (p.phase === 'pending') return p.terminalResult === undefined && !p.resultExpired;
  return Number.isFinite(p.acceptedAt) && Number.isFinite(p.expiresAt)
    && p.expiresAt! >= p.acceptedAt!
    && (p.resultExpired === true ? p.terminalResult === undefined : validAskResult(p.terminalResult));
}

/** v3 is in a child directory: historical v2 GC only scans root JSON files.
 * This protects rollback readers as well as teaching the new v2 reader to
 * preserve unknown schemas. No v3 writer ever modifies a legacy v2 record. */
export function createManagedAskStore(parentDir: string): ManagedAskStore {
  const dir = join(parentDir, 'managed-v3');
  const file = (key: string) => join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  const read = (path: string): ManagedAskRead => {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { return { found: false, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unreadable' }; }
    if (!raw || typeof raw !== 'object' || !('v' in raw) || raw.v !== 3) return { found: false, reason: 'unsupported_schema' };
    try {
      if (!validRecord(raw as PersistedManagedAsk)) return { found: false, reason: 'invalid_record' };
    } catch { return { found: false, reason: 'invalid_record' }; }
    return { found: true, record: raw as PersistedManagedAsk };
  };
  const get = (key: string): ManagedAskRead => {
    const result = read(file(key));
    return result.found && result.record.askKey !== key ? { found: false, reason: 'invalid_record' } : result;
  };
  const scan = (): PersistedManagedAsk[] => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
      const saved = read(join(dir, name));
      return saved.found && file(saved.record.askKey) === join(dir, name) ? [saved.record] : [];
    });
  };
  const putUnlocked = (record: PersistedManagedAsk): void => {
    if (record.resultExpired && record.continuation?.request) record = { ...record,
      continuation: { ...record.continuation, request: undefined } };
    if (!validRecord(record)) throw new ManagedAskError('managed_ask_invalid_record', 400);
    const prior = get(record.askKey);
    if (!prior.found && prior.reason !== 'not_found') throw new ManagedAskError(`managed_ask_${prior.reason}`);
    if (prior.found && (prior.record.askId !== record.askId
      || (prior.record.presentation.segment !== undefined && prior.record.presentation.segment !== record.presentation.segment)
      || JSON.stringify(prior.record.deliveryContext) !== JSON.stringify(record.deliveryContext)
      || JSON.stringify(prior.record.originalTurn) !== JSON.stringify(record.originalTurn)
      || JSON.stringify(prior.record.questions) !== JSON.stringify(record.questions)
      || prior.record.chatId !== record.chatId || prior.record.rootMessageId !== record.rootMessageId
      || (prior.record.phase === 'terminal' && record.phase !== 'terminal')
      || (prior.record.resultExpired && !record.resultExpired)
      || (prior.record.terminalResult && record.terminalResult
        && JSON.stringify(prior.record.terminalResult) !== JSON.stringify(record.terminalResult)))) {
      throw new ManagedAskError('managed_ask_terminal_or_identity_conflict', 409);
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      atomicWriteFileSync(file(record.askKey), JSON.stringify(record), { mode: 0o600, durable: true, followTargetSymlink: false });
    } catch { throw new ManagedAskError('managed_ask_persistence_unavailable'); }
  };
  const locked = <T>(key: string, fn: () => T): T => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return withFileLockSync(file(key), fn, { maxWaitMs: 100 });
  };
  const put = (record: PersistedManagedAsk): void => locked(record.askKey, () => {
    const prior = get(record.askKey);
    // Card callbacks/expiry may hold an older snapshot. These authority fields
    // are never erased by presentation-only or settlement writes.
    if (prior.found) record = { ...record,
      execution: prior.record.execution ?? record.execution,
      continuation: prior.record.continuation ?? record.continuation,
      presentation: prior.record.phase === 'terminal' && prior.record.presentation.revision >= record.presentation.revision
        ? prior.record.presentation : { ...record.presentation, segment: prior.record.presentation.segment ?? record.presentation.segment },
    };
    putUnlocked(record);
  });
  const expire = (key: string, now = Date.now()) => {
    const saved = get(key);
    if (!saved.found) return;
    let p = saved.record;
    if (p.phase === 'terminal' && p.expiresAt! <= now && !p.resultExpired) {
      p = { ...p, terminalResult: undefined, resultExpired: true, selections: p.questions.map(() => []),
        continuation: p.continuation ? { ...p.continuation, request: undefined } : undefined };
      put(p);
    }
    return p;
  };
  return {
    dir, get, put, expire, scan,
    create(record) {
      const id = createHash('sha256').update(record.larkAppId + '\0' + record.sessionId).digest('hex');
      const counter = join(dir, 'segments', id + '.json');
      mkdirSync(join(dir, 'segments'), { recursive: true, mode: 0o700 });
      return withFileLockSync(counter, () => {
        const existing = get(record.askKey);
        if (existing.found) throw new ManagedAskError('managed_ask_identity_conflict', 409);
        if (existing.reason !== 'not_found') throw new ManagedAskError('managed_ask_' + existing.reason);
        let last = 0;
        if (existsSync(counter)) {
          const saved = JSON.parse(readFileSync(counter, 'utf8'));
          if (saved.v !== 1 || saved.larkAppId !== record.larkAppId || saved.sessionId !== record.sessionId
            || !Number.isSafeInteger(saved.last) || saved.last < 0) throw new ManagedAskError('managed_ask_segment_counter_invalid');
          last = saved.last;
        }
        for (const saved of scan()) if (saved.larkAppId === record.larkAppId && saved.sessionId === record.sessionId)
          last = Math.max(last, saved.presentation.segment ?? 0);
        const next = { ...record, presentation: { ...record.presentation, segment: last + 1 } };
        // Counter first: a crash may leave a gap, never a reused segment.
        atomicWriteFileSync(counter, JSON.stringify({ v: 1, larkAppId: record.larkAppId, sessionId: record.sessionId, last: last + 1 }),
          { mode: 0o600, durable: true, followTargetSymlink: false });
        put(next); return next;
      }, { maxWaitMs: 100 });
    },
    update(key, change) {
      return locked(key, () => {
        const saved = get(key);
        if (!saved.found) throw new ManagedAskError(`managed_ask_${saved.reason}`);
        const next = change(saved.record);
        if (next.askKey !== key) throw new ManagedAskError('managed_ask_identity_conflict', 409);
        putUnlocked(next);
        return next;
      });
    },
    list(now = Date.now(), larkAppId?: string) {
      if (!existsSync(dir)) return [];
      const out: PersistedManagedAsk[] = [];
      for (const name of readdirSync(dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
        const r = read(join(dir, name));
        if (!r.found || file(r.record.askKey) !== join(dir, name)) continue;
        if (larkAppId && r.record.larkAppId !== larkAppId) continue;
        let p = r.record;
        if (p.phase === 'terminal' && p.expiresAt! <= now && !p.resultExpired) {
          p = { ...p, terminalResult: undefined, resultExpired: true, selections: p.questions.map(() => []),
            continuation: p.continuation ? { ...p.continuation, request: undefined } : undefined };
          put(p);
        }
        out.push(p);
      }
      return out;
    },
  };
}
