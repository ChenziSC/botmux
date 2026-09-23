import { freezeHandoffPreview, type HandoffPreview } from './handoff-preview.js';
import type { DaemonSession } from './types.js';
import type { TriggerRequest } from '../services/trigger-types.js';
import type { ManagedDeliveryContextV1 } from './managed-ask-types.js';

/** Persisted with the session. A hidden turn is never made public by timeout,
 * restart, worker replacement, or the arrival of an unrelated visible turn. */
export interface TurnStatusPolicy {
  statusCard: 'hidden' | 'visible';
  title: string;
  context?: ManagedDeliveryContextV1;
  handoffPreview?: HandoffPreview;
  state: 'prepared' | 'committed' | 'rejected';
  workerGeneration?: number;
  dispatchAttempt?: number;
  runtimeSegmentAskKey?: string;
}

export function prepareTurnStatusPolicy(ds: DaemonSession, req: TriggerRequest, turnId: string): void {
  const p = req.presentation;
  if (!p?.statusCard && !p?.deliveryContext) return;
  const policies = ds.session.turnStatusPolicies ??= {};
  // Retries cannot unhide or reset a turn that has already been consumed.
  if (policies[turnId]) return;
  policies[turnId] = { statusCard: p.statusCard ?? 'visible', state: 'prepared',
    title: p.title?.trim() || p.deliveryContext?.title || '任务执行', context: p.deliveryContext, handoffPreview: freezeHandoffPreview(req) };
}

export function bindTurnStatusDispatch(ds: DaemonSession, turnId: string, generation: number, attempt?: number): void {
  const policy = ds.session.turnStatusPolicies?.[turnId];
  if (!policy || policy.state !== 'prepared') return;
  policy.workerGeneration = generation;
  policy.dispatchAttempt = attempt;
}

/** Called only after the worker's generation has been authenticated. Plain CLI
 * turns advance the pointer too, preventing late managed events from leaking. */
export function commitTurnStatusPolicy(ds: DaemonSession, turnId: string, generation: number): boolean {
  const policy = ds.session.turnStatusPolicies?.[turnId];
  if (policy) {
    if (policy.state !== 'prepared' || policy.workerGeneration !== generation) return false;
    policy.state = 'committed';
    ds.currentTurnTitle = policy.title;
    ds.session.currentTurnTitle = policy.title;
  }
  if (ds.session.turnStatusPolicies) ds.session.statusPolicyTurnId = turnId;
  return !!policy;
}

export function rejectTurnStatusPolicy(ds: DaemonSession, turnId: string): void {
  const policy = ds.session.turnStatusPolicies?.[turnId];
  if (policy?.state === 'prepared') policy.state = 'rejected';
}

export function currentTurnStatusPolicy(ds: DaemonSession, turnId?: string): TurnStatusPolicy | undefined {
  const id = turnId ?? ds.session.statusPolicyTurnId;
  return id ? ds.session.turnStatusPolicies?.[id] : undefined;
}

/** This gate is ONLY for automatic terminal status cards. Ask, permissions,
 * user notices, final business replies and explicit /card have separate exits. */
export function automaticStatusCardHidden(ds: DaemonSession, turnId?: string): boolean {
  const policy = currentTurnStatusPolicy(ds, turnId);
  if (turnId && ds.session.statusPolicyTurnId && turnId !== ds.session.statusPolicyTurnId
    && currentTurnStatusPolicy(ds)) return true;
  if (policy && (policy.statusCard === 'hidden' || policy.runtimeSegmentAskKey || policy.state !== 'committed')) return true;
  if (policy && policy.workerGeneration !== (ds.workerGeneration ?? ds.session.workerGeneration)) return true;
  return !!policy && !!ds.session.statusPolicyTurnId && turnId !== undefined && turnId !== ds.session.statusPolicyTurnId;
}

export function statusCardTitle(ds: DaemonSession, fallback: string, turnId?: string): string {
  return currentTurnStatusPolicy(ds, turnId)?.title || ds.currentTurnTitle || ds.session.title || fallback;
}

export function captureStatusCardFence(ds: DaemonSession, turnId?: string): () => boolean {
  const id = turnId ?? ds.session.statusPolicyTurnId;
  const current = ds.session.statusPolicyTurnId;
  const generation = ds.workerGeneration ?? ds.session.workerGeneration;
  const attempt = currentTurnStatusPolicy(ds, id)?.dispatchAttempt;
  return () => ds.session.statusPolicyTurnId === current
    && (ds.workerGeneration ?? ds.session.workerGeneration) === generation
    && currentTurnStatusPolicy(ds, id)?.dispatchAttempt === attempt
    && !automaticStatusCardHidden(ds, id);
}
