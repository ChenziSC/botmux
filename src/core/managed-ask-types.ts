import type { AskResult } from './ask-types.js';

/** Public metadata, never an authorization token. Identity is bound by the daemon. */
export interface ManagedDeliveryContextV1 {
  version: 1;
  domain: 'ip' | 'gaia';
  projectId?: string;
  scopeRevision?: number;
  issue?: { id: string; revision: number };
  handoffId: string;
  stage: string;
  actor: string;
  title: string;
  sourceAsk?: { requestId: string; originKind: string };
}

export interface AskOriginalTurn {
  turnId: string;
  /** Durable dispatches have attempts; keyed async turns have none. */
  dispatchAttempt?: number;
}

/** Only the daemon may create this from its live keyed-dispatch registry. */
export interface ManagedAskExecution {
  bootId: string;
  workerGeneration: number;
  replayKey: string;
  replayKind: 'fresh' | 'turn';
  terminal?: {
    status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
    observedAt: number;
  };
  superseded?: true;
}

export interface ManagedAskPresentation {
  state: 'none' | 'pending' | 'sent' | 'cleanup_pending';
  revision: number;
  messageId?: string;
  lastError?: string;
  phase?: 'accepted' | 'running' | 'execution_completed' | 'result_recorded' | 'unknown' | 'blocked';
  blockedReason?: 'rate_limit' | 'stalled';
  turnId?: string;
  cleanupIds?: string[];
  cleanupComplete?: boolean;
  /** Monotone per app/session, allocated durably before publishing the Ask. */
  segment?: number;
  supersededBy?: string;
  retired?: boolean;
}

export interface AskContinuation {
  key: string;
  state: 'reserved' | 'accepted' | 'unknown' | 'settled';
  originalTurn: AskOriginalTurn;
  triggerId?: string;
  reason?: string;
  /** Frozen request: retries must not change receivedAt, input, or presentation. */
  request?: import('../services/trigger-types.js').TriggerRequest;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max = 200): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max;
}
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function parseManagedDeliveryContext(raw: unknown): ManagedDeliveryContextV1 | undefined {
  if (!record(raw) || raw.version !== 1 || !['ip', 'gaia'].includes(String(raw.domain))) return;
  if (!text(raw.handoffId) || !text(raw.stage) || !text(raw.actor) || !text(raw.title)) return;
  if (raw.projectId !== undefined && !text(raw.projectId)) return;
  if (raw.scopeRevision !== undefined && (!Number.isSafeInteger(raw.scopeRevision) || (raw.scopeRevision as number) < 0)) return;
  if ((raw.projectId !== undefined || raw.issue !== undefined) && raw.scopeRevision === undefined) return;
  if (raw.issue !== undefined && (!record(raw.issue) || !text(raw.issue.id) || !Number.isSafeInteger(raw.issue.revision) || (raw.issue.revision as number) < 0)) return;
  if (raw.sourceAsk !== undefined && (!record(raw.sourceAsk)
    || !text(raw.sourceAsk.requestId, 128) || !text(raw.sourceAsk.originKind, 32))) return;
  // Explicit projection removes untrusted extra fields and canonicalizes equality.
  return {
    version: 1, domain: raw.domain as 'ip' | 'gaia',
    ...(raw.projectId !== undefined ? { projectId: raw.projectId as string } : {}),
    ...(raw.scopeRevision !== undefined ? { scopeRevision: raw.scopeRevision as number } : {}),
    ...(record(raw.issue) ? { issue: { id: raw.issue.id as string, revision: raw.issue.revision as number } } : {}),
    handoffId: raw.handoffId, stage: raw.stage, actor: raw.actor, title: raw.title,
    ...(record(raw.sourceAsk) ? { sourceAsk: { requestId: raw.sourceAsk.requestId as string, originKind: raw.sourceAsk.originKind as string } } : {}),
  };
}

export function validAskOriginalTurn(value: unknown): value is AskOriginalTurn {
  return record(value) && text(value.turnId)
    && (value.dispatchAttempt === undefined || revision(value.dispatchAttempt));
}

export function validAskResult(value: unknown): value is AskResult {
  if (!record(value)) return false;
  if (value.kind === 'answered') return Array.isArray(value.answers)
    && value.answers.every(a => Array.isArray(a) && a.every(k => typeof k === 'string'))
    && text(value.by) && (value.comment === null || typeof value.comment === 'string') && value.timedOut === false;
  return value.selected === null && value.by === null && value.comment === null
    && ((value.kind === 'timedOut' && value.timedOut === true)
      || (value.kind === 'invalidated' && text(value.reason, 10000) && value.timedOut === false));
}

export class ManagedAskError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 409 | 503 = 503) {
    super(code);
    this.name = 'ManagedAskError';
  }
}
