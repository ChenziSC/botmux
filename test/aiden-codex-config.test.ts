import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAidenCodexConfig } from '../src/services/aiden-codex-config.js';

const roots: string[] = [];
function fixture(config = 'model = "same-model"\nmodel_reasoning_effort = "ultra"\n\n[mcp_servers.example]\ncommand = "same-command"\n') {
  const root = mkdtempSync(join(tmpdir(), 'aiden-codex-config-'));
  roots.push(root);
  const source = join(root, 'global');
  mkdirSync(join(source, 'sessions'), { recursive: true });
  writeFileSync(join(source, 'config.toml'), config);
  writeFileSync(join(source, 'history.jsonl'), 'original\n');
  writeFileSync(join(source, 'auth.json'), '{"fixture":true}');
  return { root, source, config };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Aiden Codex reasoning config', () => {
  it('changes only the session config and preserves native identity and shared history', () => {
    const { root, source, config } = fixture();
    const home = prepareAidenCodexConfig(source, join(root, 'session-a'), 'high');
    expect(readFileSync(join(source, 'config.toml'), 'utf8')).toBe(config);
    const generated = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(generated).toContain('model_reasoning_effort = "high"');
    expect(generated).toContain(`sqlite_home = ${JSON.stringify(source)}`);
    expect(generated).toContain('[mcp_servers.example]\ncommand = "same-command"');
    expect(realpathSync(join(home, 'sessions'))).toBe(join(source, 'sessions'));
    expect(realpathSync(join(home, 'auth.json'))).toBe(join(source, 'auth.json'));
    appendFileSync(join(home, 'history.jsonl'), 'one-submission\n');
    prepareAidenCodexConfig(source, join(root, 'session-a'), 'high');
    expect(readFileSync(join(source, 'history.jsonl'), 'utf8')).toBe('original\none-submission\n');
    expect(lstatSync(join(home, 'config.toml')).mode & 0o777).toBe(0o600);
  });

  it('keeps different session efforts independent and refreshes inherited settings on restart', () => {
    const { root, source } = fixture();
    const a = prepareAidenCodexConfig(source, join(root, 'a'), 'high');
    const b = prepareAidenCodexConfig(source, join(root, 'b'), 'low');
    appendFileSync(join(source, 'config.toml'), '\n[features]\nexample = true\n');
    prepareAidenCodexConfig(source, join(root, 'a'), 'high');
    expect(readFileSync(join(a, 'config.toml'), 'utf8')).toContain('example = true');
    expect(readFileSync(join(b, 'config.toml'), 'utf8')).toContain('model_reasoning_effort = "low"');
  });

  it('adds a missing root effort without changing an existing sqlite home', () => {
    const { root, source } = fixture('sqlite_home = "/existing/db"\n[features]\nexample = true\n');
    const home = prepareAidenCodexConfig(source, join(root, 'a'), 'high');
    const generated = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(generated.match(/sqlite_home/g)).toHaveLength(1);
    expect(generated).toContain('sqlite_home = "/existing/db"');
  });

  it('refuses an overriding profile and conflicting state instead of silently changing identity', () => {
    const { root, source } = fixture('profile = "custom"\n[profiles.custom]\nmodel_reasoning_effort = "ultra"\n');
    expect(() => prepareAidenCodexConfig(source, join(root, 'a'), 'high')).toThrow('selected Codex profile');
    writeFileSync(join(source, 'config.toml'), 'model_reasoning_effort = "ultra"\n');
    mkdirSync(join(root, 'b', 'aiden-codex'), { recursive: true, mode: 0o700 });
    symlinkSync(join(root, 'foreign'), join(root, 'b', 'aiden-codex', 'sessions'));
    expect(() => prepareAidenCodexConfig(source, join(root, 'b'), 'high')).toThrow('state link conflicts');
  });
});
