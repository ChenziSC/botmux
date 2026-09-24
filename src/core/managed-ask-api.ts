import { authorizeSessionScopedIpc, type SessionScopedIpcIdentity } from './daemon-ipc-session-auth.js';
import type { VcMeetingLiveManagedOrigin } from '../services/vc-meeting-send-policy.js';
import type { AskLookupIdentity } from './ask-broker.js';
import { ManagedAskError, validAskOriginalTurn, type AskOriginalTurn } from './managed-ask-types.js';

export function parseAskLookup(raw: unknown): AskLookupIdentity {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ManagedAskError('bad_body', 400);
  const r = raw as Record<string, unknown>;
  for (const key of ['larkAppId', 'sessionId', 'chatId', 'requestId', 'originKind']) {
    const max = key === 'originKind' ? 32 : 128;
    if (typeof r[key] !== 'string' || !(r[key] as string).trim() || (r[key] as string).length > max) {
      throw new ManagedAskError(`bad_${key}`, 400);
    }
  }
  if (r.rootMessageId !== null && typeof r.rootMessageId !== 'string') throw new ManagedAskError('bad_rootMessageId', 400);
  return Object.fromEntries(['larkAppId', 'sessionId', 'chatId', 'rootMessageId', 'requestId', 'originKind'].map(k => [k, r[k]])) as unknown as AskLookupIdentity;
}

export interface ManagedAskSession extends SessionScopedIpcIdentity {
  receiver?: boolean;
  liveOrigin?: VcMeetingLiveManagedOrigin;
  /** Computed from the live keyed registry, never from request metadata. */
  keyedTurnId?: string;
}

/** Shared daemon seam for registration/lookup. A trusted host can look up a
 * closed session, but cannot invent the identity or re-use a stale worker token. */
export function authorizeManagedAsk(args: {
  identity: SessionScopedIpcIdentity;
  raw: Record<string, unknown>;
  session?: ManagedAskSession;
  trustedHost: boolean;
  selfAppId?: string;
  registration: boolean;
}): AskOriginalTurn | undefined {
  const { session, identity, raw } = args;
  if (!session || session.receiver || !args.selfAppId
    || session.larkAppId !== args.selfAppId
    || (['sessionId', 'larkAppId', 'chatId', 'rootMessageId'] as const).some(k => session[k] !== identity[k])) {
    throw new ManagedAskError('managed_ask_identity_unproven', 403);
  }
  const auth = authorizeSessionScopedIpc({
    trustedHost: args.trustedHost, sessionExists: true, receiverSession: !!session.receiver,
    allowReceiver: false, sessionId: session.sessionId, liveOrigin: session.liveOrigin,
    claimedCapability: typeof raw.originCapability === 'string' ? raw.originCapability : undefined,
    claimedTurnId: typeof raw.originTurnId === 'string' ? raw.originTurnId : undefined,
    claimedDispatchAttempt: typeof raw.originDispatchAttempt === 'number' ? raw.originDispatchAttempt : undefined,
  });
  if (!auth.ok) throw new ManagedAskError(auth.error, 403);
  if (!args.registration) return;
  const originalTurn = { turnId: session.liveOrigin?.turnId, dispatchAttempt: session.liveOrigin?.dispatchAttempt };
  if (!validAskOriginalTurn(originalTurn) || raw.originTurnId !== originalTurn.turnId
    || raw.originDispatchAttempt !== originalTurn.dispatchAttempt) {
    throw new ManagedAskError('managed_ask_original_turn_unproven', 403);
  }
  if (originalTurn.dispatchAttempt === undefined && session.keyedTurnId !== originalTurn.turnId) {
    throw new ManagedAskError('managed_ask_keyed_turn_unproven', 403);
  }
  return originalTurn;
}
