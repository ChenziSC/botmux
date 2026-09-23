import { parseAskLookup } from '../core/managed-ask-api.js';
import { ManagedAskError } from '../core/managed-ask-types.js';

/** Owner-only recovery proxy. It forwards no worker capability and never falls
 * back to creating/re-registering an Ask when the original daemon is offline. */
export async function lookupAskForOwner(args: {
  ownerAuthenticated: boolean;
  sessionId: string;
  raw: unknown;
  operation?: 'lookup' | 'continue';
  proxyToDaemon: (app: string, path: string, init: RequestInit) => Promise<Response>;
}): Promise<{ status: number; body: unknown }> {
  if (!args.ownerAuthenticated) return { status: 403, body: { ok: false, error: 'core_owner_required' } };
  let identity;
  try {
    identity = parseAskLookup(args.raw);
    if (identity.sessionId !== args.sessionId) throw new ManagedAskError('session_identity_conflict', 403);
  } catch (e) {
    return { status: e instanceof ManagedAskError ? e.status : 400, body: { ok: false, error: (e as Error).message } };
  }
  try {
    const response = await args.proxyToDaemon(identity.larkAppId, `/api/asks/${args.operation ?? 'lookup'}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(identity),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, body: await response.json() };
  } catch {
    return { status: 503, body: { found: false, state: 'unknown', reason: 'daemon_unavailable' } };
  }
}
