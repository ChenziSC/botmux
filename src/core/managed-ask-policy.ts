import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import type { ManagedAskPolicy } from './managed-ask-continuation.js';

const loading = new Map<string, Promise<ManagedAskPolicy>>();
/** Process-owner configuration only. Never reads a path from an Ask or Trigger.
 * The release installer pins an independent module in each domain's package. */
export async function loadManagedAskPolicy(configuredPath?: string | null): Promise<ManagedAskPolicy | undefined> {
  // The supervisor shares its environment across all bots. Prefer the owning
  // bot's host-only persisted config, including an explicit empty/null value
  // to disable the inherited policy. This is deliberately separate from CLI
  // env, whose BOTMUX-prefixed settings remain reserved and filtered.
  const modulePath = (configuredPath === undefined
    ? process.env.BOTMUX_MANAGED_ASK_POLICY_MODULE : configuredPath)?.trim();
  if (!modulePath) return undefined;
  let policy = loading.get(modulePath);
  if (!policy) {
    policy = (async () => {
      if (!isAbsolute(modulePath)) throw new Error('managed_ask_policy_path_must_be_absolute');
      const module = await import(pathToFileURL(realpathSync(modulePath)).href);
      if (module.managedAskPolicyVersion !== 1 || typeof module.inspectManagedAsk !== 'function') {
        throw new Error('managed_ask_policy_contract_invalid');
      }
      return module.inspectManagedAsk as ManagedAskPolicy;
    })();
    loading.set(modulePath, policy);
  }
  return policy;
}
