import { handoffPreviewElements } from './handoff-preview.js';
import { createHash } from 'node:crypto';
import type { ManagedAskStore, PersistedManagedAsk } from './managed-ask-store.js';
import type { ManagedAskPresentation } from './managed-ask-types.js';

export interface ManagedAskPresentationIO {
  send(record: PersistedManagedAsk, body: string, uuid: string): Promise<string>;
  patch(record: PersistedManagedAsk, messageId: string, body: string): Promise<unknown>;
  /** Daemon-owned exact-turn runtime messages only, never caller-provided IDs. */
  retire(record: PersistedManagedAsk): string[];
  commitRetirement?(record: PersistedManagedAsk, messageIds: string[]): void;
  remove(record: PersistedManagedAsk, messageId: string): Promise<unknown>;
}

export function buildManagedAskRuntimeCard(record: PersistedManagedAsk): string {
  const c = record.deliveryContext;
  const stages: Record<string, string> = { architecture: '方案设计', development: '开发', implementation: '开发', review: '代码审查', validation: '验收', deployment: '部署', recovery: '进度核查', final_delivery: '结果交付' };
  const actors: Record<string, string> = { leader: '协调机器人', developer: '开发机器人', reviewer: '审查机器人', validator: '验收机器人', quality: '质量机器人', architecture: '方案机器人' };
  const labels = { accepted: '已收到答复 · 等待继续处理', running: '正在处理你的答复',
    blocked: record.presentation.blockedReason === 'rate_limit'
      ? '执行器限流 · 等待额度恢复；持续未恢复时由任务负责人检查运行状态'
      : '执行暂时停滞 · 由任务负责人检查原任务；不会自动重复派单',
    execution_completed: '本轮执行结束 · 正在核对阶段结果', result_recorded: '阶段结果已记录', unknown: '执行状态待核实 · 请由任务负责人检查原任务' };
  return JSON.stringify({ schema: '2.0', config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: c.title }, template: 'blue' },
    body: { elements: [{ tag: 'markdown', content: labels[record.presentation.phase ?? 'accepted'] },
      { tag: 'markdown', content: `阶段：${stages[c.stage] ?? c.stage} · ${actors[c.actor] ?? c.actor}` }, ...handoffPreviewElements(record.handoffPreview)] } });
}

/** One durable runtime segment under each answered Ask. No model turn is used
 * to send status. Transport uncertainty retries the SAME provider UUID. */
export function createManagedAskPresenter(store: ManagedAskStore, io: ManagedAskPresentationIO) {
  const queues = new Map<string, Promise<void>>();
  const retries = new Map<string, number>();
  const sameChain = (a: PersistedManagedAsk, b: PersistedManagedAsk) => a.larkAppId === b.larkAppId
    && a.sessionId === b.sessionId && a.deliveryContext.handoffId === b.deliveryContext.handoffId;
  const newerExists = (record: PersistedManagedAsk) => !!record.presentation.segment && store.scan().some(other =>
    sameChain(record, other) && (other.presentation.segment ?? 0) > record.presentation.segment!);
  const retireOwn = async (record: PersistedManagedAsk) => {
    const successor = record.presentation.supersededBy && store.get(record.presentation.supersededBy);
    if (!successor || !successor.found || !sameChain(record, successor.record)
      || !successor.record.presentation.messageId || !record.presentation.messageId) return;
    await io.remove(record, record.presentation.messageId);
    store.update(record.askKey, current => ({ ...current, presentation: { ...current.presentation,
      retired: true, state: 'sent', lastError: undefined } }));
  };
  const publish = (key: string): Promise<void> => {
    const pending = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      let read = store.get(key);
      if (!read.found || read.record.terminalResult?.kind !== 'answered' || read.record.resultExpired) return;
      let record = read.record;
      if (record.presentation.retired) return;
      if (!record.cardMessageId) return; // Original card POST may still be in flight.
      try {
        if (record.presentation.supersededBy) { await retireOwn(record); return; }
        const revision = record.presentation.revision;
        if (!record.presentation.messageId) {
          const uuid = 'ask_run_' + createHash('sha256').update(key).digest('hex').slice(0, 40);
          const messageId = await io.send(record, buildManagedAskRuntimeCard(record), uuid);
          if (!/^om_[\w-]+$/.test(messageId)) throw new Error('runtime_message_identity_missing');
          record = store.update(key, current => ({ ...current, presentation: {
            ...current.presentation, state: 'sent', messageId, lastError: undefined,
          } }));
          if (record.presentation.supersededBy) { await retireOwn(record); return; }
          // A working/terminal event may have arrived while the first POST ran.
          if (record.presentation.revision !== revision) await io.patch(record, messageId, buildManagedAskRuntimeCard(record));
        } else {
          await io.patch(record, record.presentation.messageId, buildManagedAskRuntimeCard(record));
        }
        // Save new reference BEFORE retiring old runtime-only messages. A POST
        // or persistence failure must leave the old useful evidence intact.
        if (!record.presentation.cleanupComplete && !record.presentation.cleanupIds) {
          const ids = io.retire(record).filter(id => /^om_[\w-]+$/.test(id)
            && id !== record.cardMessageId && id !== record.presentation.messageId);
          // Freeze older same-chain segments only AFTER the new reference is
          // durable. Their in-flight POST callbacks will retire themselves.
          for (const previous of store.scan()) {
            if (!sameChain(record, previous) || !previous.presentation.segment
              || previous.presentation.segment >= (record.presentation.segment ?? 0)) continue;
            const frozen = store.update(previous.askKey, current => ({ ...current,
              presentation: { ...current.presentation, supersededBy: key, revision: current.presentation.revision + 1 } }));
            if (frozen.presentation.messageId) ids.push(frozen.presentation.messageId);
          }
          record = store.update(key, current => ({ ...current, presentation: { ...current.presentation, cleanupIds: [...new Set(ids)] } }));
        }
        io.commitRetirement?.(record, record.presentation.cleanupIds ?? []);
        const remaining: string[] = [];
        for (const id of record.presentation.cleanupIds ?? []) {
          try { await io.remove(record, id); } catch { remaining.push(id); }
        }
        store.update(key, current => ({ ...current, presentation: { ...current.presentation,
          state: remaining.length ? 'cleanup_pending' : 'sent', cleanupIds: remaining,
          cleanupComplete: remaining.length === 0, lastError: remaining.length ? 'runtime_cleanup_failed' : undefined,
        } }));
        if (!remaining.length) retries.delete(key);
      } catch (error) {
        store.update(key, current => ({ ...current, presentation: { ...current.presentation,
          state: current.presentation.messageId ? 'cleanup_pending' : 'pending',
          lastError: error instanceof Error ? error.message.slice(0, 200) : 'presentation_failed',
        } }));
      }
      const latest = store.get(key);
      if (latest.found && ['pending', 'cleanup_pending'].includes(latest.record.presentation.state)
        && (retries.get(key) ?? 0) < 3) {
        const attempt = (retries.get(key) ?? 0) + 1; retries.set(key, attempt);
        const timer = setTimeout(() => { void publish(key).catch(() => {}); }, attempt * 1000);
        timer.unref?.();
      }
    });
    queues.set(key, pending);
    void pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); }).catch(() => {});
    return pending;
  };
  const advance = (key: string, phase: ManagedAskPresentation['phase'], turnId: string, blockedReason?: ManagedAskPresentation['blockedReason']): Promise<void> => {
    const existing = store.get(key);
    if (!existing.found) return Promise.resolve();
    const prior = existing.record.presentation;
    if (prior.retired || prior.supersededBy) return Promise.resolve();
    if ((prior.phase === 'result_recorded' || (prior.turnId === turnId
      && ((prior.phase === phase && prior.blockedReason === blockedReason)
        || (prior.phase === 'execution_completed' && phase !== 'result_recorded'))))
      && (prior.state === 'sent' || (retries.get(key) ?? 0) >= 3)) return Promise.resolve();
    if (newerExists(existing.record)) return Promise.resolve();
    let changed = false;
    const updated = store.update(key, current => {
      if (current.terminalResult?.kind !== 'answered' || current.resultExpired) return current;
      const activeTurn = current.continuation?.triggerId ?? current.originalTurn.turnId;
      if (activeTurn !== turnId) return current;
      if (!current.continuation?.triggerId && current.execution?.terminal && (phase === 'running' || phase === 'blocked')) return current;
      const p = current.presentation;
      if (p.phase === 'result_recorded' || p.turnId === turnId && ((p.phase === phase && p.blockedReason === blockedReason)
        || (p.phase === 'execution_completed' && phase !== 'result_recorded'))) return current;
      changed = true;
      return { ...current, presentation: { ...p, phase, blockedReason, turnId, revision: p.revision + 1 } };
    });
    return changed || (['pending', 'cleanup_pending'].includes(updated.presentation.state) && (retries.get(key) ?? 0) < 3) ? publish(key) : Promise.resolve();
  };
  return { publish, advance };
}
