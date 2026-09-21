import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { runHostOperationalEffect } from '../src/core/installation-maintenance.js';

afterEach(() => vi.useRealTimers());

describe('explicit installation maintenance window', () => {
  it('does not start operational timers or fabricate checked/notified state', async () => {
    vi.useFakeTimers();
    const ledger: string[] = [];
    const sendOwnerNotice = vi.fn();
    runHostOperationalEffect(() => {
      ledger.push('lastCheckedAt');
      setTimeout(() => { ledger.push('lastNotifiedVersion'); sendOwnerNotice(); }, 20_000);
      setInterval(sendOwnerNotice, 30_000);
    }, { BOTMUX_MAINTENANCE_MODE: '1' });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(ledger).toEqual([]);
    expect(sendOwnerNotice).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, '', '0', 'true', ' 1 '])('preserves normal effects for non-opt-in value %j', value => {
    const send = vi.fn(() => 'sent');
    expect(runHostOperationalEffect(send, { BOTMUX_MAINTENANCE_MODE: value })).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not hide normal effect failures', () => {
    const error = new Error('notification adapter failed');
    expect(() => runHostOperationalEffect(() => { throw error; }, {})).toThrow(error);
  });

  it('guards only operational startup/notice sites and leaves logging and authorization outside', () => {
    // Parse the production wiring, avoiding importing a module that boots a daemon.
    const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    const root = ts.createSourceFile('daemon.ts', source, ts.ScriptTarget.Latest, true);
    const guarded: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(root) === 'runHostOperationalEffect') guarded.push(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
    expect(guarded).toHaveLength(3);
    const texts = guarded.map(node => node.getText(root));
    expect(texts.filter(text => text.includes('startMaintenance()') && text.includes('startCliRuntimeUpdateMonitor') && text.includes('sendRestartReportIfPending'))).toHaveLength(1);
    expect(texts.filter(text => text.includes('setInterval') && text.includes('evaluateOverload'))).toHaveLength(1);
    expect(texts.filter(text => text.includes('allowedUsers 解析告警'))).toHaveLength(1);
    for (const text of texts) {
      expect(text).not.toContain('resolveAllowedUsersWithMap');
      expect(text).not.toContain('writeAllowedUsersCache');
      expect(text).not.toContain('logger.error');
      expect(text).not.toContain('settleTurnReplyCards');
      expect(text).not.toContain('settleCotMessageForShutdown');
      expect(text).not.toContain('setAskCardDispatcher');
    }
  });
});
