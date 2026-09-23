import { readFileSync, statSync } from 'node:fs';
import { ManagedAskError, parseManagedDeliveryContext } from './managed-ask-types.js';

/** Local CLI input only; paths are never sent to the daemon or IM renderer. */
export function readManagedAskArgs(requestId?: string, contextFile?: string) {
  if (requestId !== undefined && (!requestId.trim() || requestId.length > 128)) {
    throw new ManagedAskError('bad_requestId', 400);
  }
  if (contextFile === undefined) return requestId ? { requestId } : {};
  if (!requestId) throw new ManagedAskError('managed_ask_request_id_required', 400);
  try {
    const stat = statSync(contextFile);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('invalid context file');
    const context = parseManagedDeliveryContext(JSON.parse(readFileSync(contextFile, 'utf8')));
    if (!context) throw new Error('invalid context');
    return { requestId, managedDelivery: context };
  } catch { throw new ManagedAskError('bad_delivery_context_file', 400); }
}

/** Do not silently downgrade a malformed managed invocation to a legacy Ask. */
export function readManagedAskArgsFromArgv(args: string[]) {
  const value = (flag: string): string | undefined => {
    const hits = args.filter(a => a === flag || a.startsWith(`${flag}=`));
    if (hits.length > 1) throw new ManagedAskError(`duplicate_${flag}`, 400);
    if (!hits.length) return;
    const found = hits[0];
    const result = found.includes('=') ? found.slice(flag.length + 1) : args[args.indexOf(found) + 1];
    if (!result || result.startsWith('--')) throw new ManagedAskError(`missing_${flag}`, 400);
    return result;
  };
  return readManagedAskArgs(value('--request-id'), value('--delivery-context-file'));
}

/** Chat-scoped env still carries a trace root. It is not an Ask reply anchor. */
export function managedAskRootFromEnv(env: NodeJS.ProcessEnv): string | null {
  if (env.BOTMUX_SESSION_SCOPE === 'chat') return null;
  const root = env.BOTMUX_ROOT_MESSAGE_ID;
  return root?.startsWith('om_') ? root : null;
}
