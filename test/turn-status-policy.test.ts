import { describe, it, expect } from 'vitest';
import { prepareTurnStatusPolicy, bindTurnStatusDispatch, commitTurnStatusPolicy,
  automaticStatusCardHidden, captureStatusCardFence, statusCardTitle, rejectTurnStatusPolicy } from '../src/core/turn-status-policy.js';
import type { DaemonSession } from '../src/core/types.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';

const make = () => ({ session: { title: 'architecture', status: 'active', workerGeneration: 4 },
  workerGeneration: 4, currentTurnTitle: 'architecture' }) as DaemonSession;
const req = (hidden = false) => ({ presentation: { ...(hidden ? { statusCard: 'hidden' } : {}),
  deliveryContext: { version: 1, domain: 'ip', handoffId: 'h', stage: hidden ? 'recovery' : 'validation',
    actor: hidden ? 'leader' : 'quality', title: hidden ? '进度核查' : '页面验收' } } }) as TriggerRequest;
function start(ds: DaemonSession, id: string, hidden = false) {
  prepareTurnStatusPolicy(ds, req(hidden), id); bindTurnStatusDispatch(ds, id, 4, 1);
  commitTurnStatusPolicy(ds, id, 4);
}

describe('managed turn status policy', () => {
  it('C6: closed architecture followed by silent governance survives idle, restore and stale callbacks', () => {
    const ds = make();
    ds.session.handoffLiveCard = { turnId: 'architecture', sequence: 2, closed: true };
    start(ds, 'governance', true);
    const callback = captureStatusCardFence(ds, 'governance');
    expect(automaticStatusCardHidden(ds)).toBe(true);
    ds.session = JSON.parse(JSON.stringify(ds.session));
    expect(automaticStatusCardHidden(ds, 'governance')).toBe(true);
    start(ds, 'validation');
    expect(statusCardTitle(ds, 'fallback')).toBe('页面验收');
    expect(automaticStatusCardHidden(ds, 'validation')).toBe(false);
    expect(callback()).toBe(false);
    expect(automaticStatusCardHidden(ds, 'governance')).toBe(true);
    expect(commitTurnStatusPolicy(ds, 'governance', 4)).toBe(false);
    expect(ds.session.statusPolicyTurnId).toBe('validation');
  });
  it('queued/rejected input cannot publish; wrong generation cannot commit', () => {
    const ds = make(); start(ds, 'active');
    prepareTurnStatusPolicy(ds, req(true), 'queued'); bindTurnStatusDispatch(ds, 'queued', 5, 2);
    expect(automaticStatusCardHidden(ds, 'active')).toBe(false);
    expect(commitTurnStatusPolicy(ds, 'queued', 4)).toBe(false);
    rejectTurnStatusPolicy(ds, 'queued');
    expect(commitTurnStatusPolicy(ds, 'queued', 5)).toBe(false);
    expect(ds.session.statusPolicyTurnId).toBe('active');
  });
  it('does not inherit managed title/idle policy into ordinary CLI input', () => {
    const ds = make(); start(ds, 'hidden', true);
    commitTurnStatusPolicy(ds, 'plain', 4);
    expect(automaticStatusCardHidden(ds)).toBe(false);
    expect(automaticStatusCardHidden(ds, 'hidden')).toBe(true);
  });
  it('captures generation, attempt and turn before delayed publication', () => {
    const ds = make(); start(ds, 'active');
    const fence = captureStatusCardFence(ds);
    expect(fence()).toBe(true);
    ds.workerGeneration = 5; expect(fence()).toBe(false);
    ds.workerGeneration = 4; ds.session.turnStatusPolicies!.active.dispatchAttempt = 2;
    expect(fence()).toBe(false);
  });
});
