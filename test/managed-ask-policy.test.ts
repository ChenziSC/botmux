import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManagedAskPolicy } from '../src/core/managed-ask-policy.js';
import { parseBotConfigsFromText } from '../src/bot-registry.js';

const temporary: string[] = [];
const envKey = 'BOTMUX_MANAGED_ASK_POLICY_MODULE';

function fixture(label: string, version = 1): string {
  const dir = mkdtempSync(join(tmpdir(), 'managed-ask-policy-'));
  temporary.push(dir);
  const file = join(dir, 'policy.mjs');
  writeFileSync(file, `export const managedAskPolicyVersion = ${version};\n`
    + `export const inspectManagedAsk = () => ({ state: 'unknown', reason: ${JSON.stringify(label)} });\n`);
  return file;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('managed Ask policy selection for a shared supervisor', () => {
  it('loads each bot policy independently even with a shared inherited policy', async () => {
    const inherited = fixture('inherited');
    const first = fixture('first-platform');
    const second = fixture('second-platform');
    vi.stubEnv(envKey, inherited);
    const bots = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'cli_first', larkAppSecret: 'fake', cliId: 'codex', managedAskPolicyModule: first,
        env: { [envKey]: second, IP_MANAGED_ASK: '1' } },
      { larkAppId: 'cli_second', larkAppSecret: 'fake', cliId: 'codex', managedAskPolicyModule: second },
    ]));
    expect(bots[0].env).toEqual({ IP_MANAGED_ASK: '1' });
    const [a, b] = await Promise.all(bots.map(bot => loadManagedAskPolicy(bot.managedAskPolicyModule)));
    const aModule = await import(first);
    const bModule = await import(second);
    expect(a).toBe(aModule.inspectManagedAsk);
    expect(b).toBe(bModule.inspectManagedAsk);
    expect(a).not.toBe(b);
    expect(await loadManagedAskPolicy(first)).toBe(a);
  });

  it('retains the inherited default only when the bot has no explicit setting', async () => {
    const inherited = fixture('legacy-default');
    vi.stubEnv(envKey, inherited);
    expect(await loadManagedAskPolicy()).toBe((await import(inherited)).inspectManagedAsk);
    expect(await loadManagedAskPolicy('  ')).toBeUndefined();
    expect(await loadManagedAskPolicy(null)).toBeUndefined();
    vi.stubEnv(envKey, undefined);
    expect(await loadManagedAskPolicy()).toBeUndefined();
  });

  it('rejects a broken bot policy without falling back to the inherited platform', async () => {
    vi.stubEnv(envKey, fixture('other-platform'));
    await expect(loadManagedAskPolicy('relative/policy.mjs'))
      .rejects.toThrow('managed_ask_policy_path_must_be_absolute');
    await expect(loadManagedAskPolicy(fixture('incompatible', 2)))
      .rejects.toThrow('managed_ask_policy_contract_invalid');
  });

  it('preserves explicit invalid/disabled settings through registry parsing without inheriting', async () => {
    vi.stubEnv(envKey, fixture('other-platform'));
    for (const value of [null, {}, 42, false, '']) {
      const [bot] = parseBotConfigsFromText(JSON.stringify([
        { larkAppId: 'cli_test', larkAppSecret: 'fake', cliId: 'codex', managedAskPolicyModule: value },
      ]));
      expect(bot.managedAskPolicyModule).not.toBeUndefined();
      expect(await loadManagedAskPolicy(bot.managedAskPolicyModule)).toBeUndefined();
    }
  });
});
