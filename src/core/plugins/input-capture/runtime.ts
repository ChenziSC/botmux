import { captureDigest, createInputCaptureStore, type CapturedInput, type InputBinding } from './store.js';
import { parseInputCaptureConditions } from './conditions.js';

export interface CaptureSession {
  sessionId: string; larkAppId: string; chatId: string; anchor: string;
  ownerOpenId: string; active: boolean;
}
export interface InputCaptureOptions {
  larkAppId: string;
  store: ReturnType<typeof createInputCaptureStore>;
  session(id: string): CaptureSession | undefined;
  pluginEnabled(pluginId: string): boolean;
  canTalk(session: CaptureSession, actor: string, memberUnionId?: string): boolean;
  deliver(binding: InputBinding, input: CapturedInput): Promise<void>;
  warn?(): void;
}
const valid = (s: unknown, max = 200): s is string => typeof s === 'string'
  && !!s.trim() && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s);

export function createInputCaptureRuntime(options: InputCaptureOptions) {
  const { store, larkAppId } = options;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const matchesSession = (binding: InputBinding, session: CaptureSession | undefined): session is CaptureSession =>
    !!session && session.active && session.larkAppId === binding.larkAppId
      && session.sessionId === binding.sessionId && session.chatId === binding.chatId
      && session.anchor === binding.sourceAnchor && session.ownerOpenId === binding.ownerOpenId;
  async function flush() {
    // Preserve source order per binding. Offline / rejected inputs remain pending.
    const journal = store.read(); const blocked = new Set<string>();
    for (const input of journal.inputs) {
      if (stopped) return;
      if (input.delivery !== 'pending' || blocked.has(input.bindingId)) continue;
      const binding = journal.bindings.find(b => b.id === input.bindingId)!;
      if (!options.pluginEnabled(binding.pluginId)) { blocked.add(binding.id); continue; }
      try {
        // Previously accepted input is delivered even after capture revocation.
        // Its snapshot is historical evidence, never a current execution grant.
        await options.deliver(binding, input);
        store.transact(state => {
          const current = state.inputs.find(row => row.id === input.id);
          if (!current || JSON.stringify({ ...current, delivery: 'pending', acknowledgedAt: undefined })
            !== JSON.stringify({ ...input, acknowledgedAt: undefined })) throw new Error('input_capture_input_changed');
          current.delivery = 'acknowledged'; current.acknowledgedAt = new Date().toISOString();
        });
      } catch { blocked.add(binding.id); options.warn?.(); }
    }
  }
  const kick = () => {
    if (stopped) return Promise.resolve();
    if (!running) running = flush().catch(() => options.warn?.()).finally(() => { running = undefined; });
    return running;
  };
  return {
    register(sessionId: string, body: Record<string, unknown>) {
      if (!valid(body.pluginId, 100) || !valid(body.requestId, 128) || !valid(body.providerRef, 1000)
        || body.inputAnchor !== undefined && (typeof body.inputAnchor !== 'string' || !/^om_[A-Za-z0-9_-]+$/.test(body.inputAnchor))) throw new Error('invalid_input_capture_request');
      const session = options.session(sessionId);
      if (!session || session.sessionId !== sessionId || !session.active || session.larkAppId !== larkAppId || !/^ou_[A-Za-z0-9_-]+$/.test(session.ownerOpenId)
        || !/^oc_[A-Za-z0-9_-]+$/.test(session.chatId) || !/^(?:om_|oc_)[A-Za-z0-9_-]+$/.test(session.anchor)
        || !options.canTalk(session, session.ownerOpenId)) throw new Error('input_capture_session_unavailable');
      if (!options.pluginEnabled(body.pluginId)) throw new Error('input_capture_plugin_unavailable');
      const anchor = (body.inputAnchor ?? session.anchor) as string;
      const id = captureDigest([larkAppId, sessionId, body.pluginId, body.requestId]);
      return store.transact(state => {
        const prior = state.bindings.find(b => b.id === id);
        if (prior) {
          if (!matchesSession(prior, session) || prior.providerRef !== body.providerRef || prior.anchor !== anchor) throw new Error('input_capture_identity_conflict');
          return prior;
        }
        if (state.bindings.some(b => b.active && b.chatId === session.chatId
          && b.anchor === anchor && b.ownerOpenId === session.ownerOpenId)) throw new Error('input_capture_anchor_conflict');
        const binding: InputBinding = { id, revision: 1, active: true, larkAppId, sessionId,
          chatId: session.chatId, anchor, sourceAnchor: session.anchor, ownerOpenId: session.ownerOpenId,
          pluginId: body.pluginId as string, requestId: body.requestId as string, providerRef: body.providerRef as string,
          createdAt: new Date().toISOString() };
        state.bindings.push(binding); return binding;
      });
    },
    inspect(sessionId: string, bindingId: string) {
      const state = store.read(); const binding = state.bindings.find(b => b.id === bindingId && b.sessionId === sessionId);
      if (!binding) return undefined;
      return { binding, inputs: state.inputs.filter(row => row.bindingId === bindingId) };
    },
    revoke(sessionId: string, bindingId: string, expectedRevision: number) {
      return store.transact(state => {
        const binding = state.bindings.find(b => b.id === bindingId && b.sessionId === sessionId);
        if (!binding || binding.revision !== expectedRevision) throw new Error('input_capture_revision_conflict');
        if (binding.active) { binding.active = false; binding.revision++; }
        return binding;
      });
    },
    revokeSet(sessionId: string, value: unknown) {
      const conditions = parseInputCaptureConditions(value);
      return store.transact(state => {
        // Check every stream before changing any of them. A new input does not
        // increment the binding revision, so both preconditions are necessary.
        const entries = conditions.map(condition => {
          const binding = state.bindings.find(b => b.id === condition.bindingId && b.sessionId === sessionId);
          if (!binding || binding.revision !== condition.expectedRevision) throw new Error('input_capture_revision_conflict');
          const inputCount = state.inputs.filter(input => input.bindingId === binding.id).length;
          if (inputCount !== condition.expectedInputCount) throw new Error('input_capture_inputs_conflict');
          return { binding, inputCount };
        });
        for (const { binding } of entries) {
          if (binding.active) { binding.active = false; binding.revision++; }
        }
        return { bindings: entries };
      });
    },
    capture(event: { messageId: string; chatId: string; anchor: string; senderOpenId: string;
      memberUnionId?: string; text: string; botSender: boolean }): boolean {
      if (event.botSender || !valid(event.messageId) || !valid(event.senderOpenId) || !event.text.trim()) return false;
      const state = store.read();
      const historical = state.inputs.find(row => row.messageId === event.messageId && state.bindings.some(b =>
        b.id === row.bindingId && b.chatId === event.chatId && b.anchor === event.anchor && b.ownerOpenId === event.senderOpenId));
      if (historical) {
        if (historical.text !== event.text) throw new Error('input_capture_message_conflict');
        void kick(); return true;
      }
      const binding = state.bindings.find(b => b.active && b.chatId === event.chatId
        && b.anchor === event.anchor && b.ownerOpenId === event.senderOpenId);
      if (!binding) return false;
      // Once a binding owns a route, invalidated authority must not turn it into
      // an unrelated Worker prompt. Keep the binding for explicit reconciliation.
      const session = options.session(binding.sessionId);
      if (!matchesSession(binding, session) || !options.canTalk(session, event.senderOpenId, event.memberUnionId)) {
        throw new Error('input_capture_authority_changed');
      }
      if (Buffer.byteLength(event.text, 'utf8') > 64 * 1024) throw new Error('input_capture_text_too_large');
      store.transact(current => {
        const active = current.bindings.find(b => b.id === binding.id);
        if (!active?.active || active.revision !== binding.revision) throw new Error('input_capture_revision_conflict');
        const id = captureDigest([binding.id, event.messageId]);
        const prior = current.inputs.find(row => row.id === id);
        if (prior) {
          if (prior.senderOpenId !== event.senderOpenId || prior.text !== event.text) throw new Error('input_capture_message_conflict');
          return;
        }
        current.inputs.push({ id, bindingId: binding.id,
          sequence: current.inputs.filter(row => row.bindingId === binding.id).length + 1,
          messageId: event.messageId, senderOpenId: event.senderOpenId, text: event.text,
          receivedAt: new Date().toISOString(), delivery: 'pending' });
      });
      void kick(); return true;
    },
    start() {
      if (timer || stopped) return;
      void kick(); timer = setInterval(() => { void kick(); }, 5000); timer.unref();
    },
    drain: kick,
    stop() { stopped = true; clearInterval(timer); return running ?? Promise.resolve(); },
  };
}
export type InputCaptureRuntime = ReturnType<typeof createInputCaptureRuntime>;
const runtimes = new Map<string, InputCaptureRuntime>();
export function setInputCaptureRuntime(appId: string, runtime: InputCaptureRuntime): void { runtimes.set(appId, runtime); }
export function getInputCaptureRuntime(appId: string): InputCaptureRuntime | undefined { return runtimes.get(appId); }

export function stopInputCaptureRuntimes(): Promise<void> {
  return Promise.all([...runtimes.values()].map(runtime => runtime.stop())).then(() => {});
}
