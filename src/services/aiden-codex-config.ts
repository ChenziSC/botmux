import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecureHostFileSync } from '../platform/secure-host-file.js';

/** A resumed Aiden TUI can omit the banner needed by the startup gate. Ask for
 * one redraw only at its empty composer; this is not permission to send input. */
export function aidenCodexResumeNeedsRedraw(screen: string): boolean {
  if (/(?:model|directory):\s*loading\b|Resuming session|esc to interrupt|Queued for capacity/i.test(screen)) return false;
  const lines = screen.trimEnd().split(/\r?\n/).filter(line => line.trim());
  return /^\s*›\s*(?:Ask Codex to do anything)?\s*$/.test(lines.at(-2) ?? '')
    && /^\s*\S+ (?:low|medium|high|xhigh|max|ultra) · (?:\/|~)\S*(?: · [^\r\n]+)?\s*$/.test(lines.at(-1) ?? '');
}

/** Aiden rejects Codex -c overrides. Give this session its own config while
 * retaining the existing login, native thread database and transcript paths.
 * This is configuration separation, not credential or filesystem isolation. */
export function prepareAidenCodexConfig(sourceHome: string, sessionDir: string, effort: string): string {
  if (!/^(none|minimal|low|medium|high|xhigh|ultra|max)$/.test(effort)) {
    throw new Error('Invalid Aiden Codex reasoning effort');
  }
  const source = realpathSync(sourceHome);
  const target = join(sessionDir, 'aiden-codex');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw new Error('Aiden Codex config home must be a private regular directory');
  }
  const original = readFileSync(join(source, 'config.toml'), 'utf8');
  const firstTable = original.search(/^\s*\[/m);
  let root = firstTable < 0 ? original : original.slice(0, firstTable);
  const tables = firstTable < 0 ? '' : original.slice(firstTable);
  // Do not claim a root override wins over an explicitly selected profile.
  if (/^\s*profile\s*=/m.test(root)) {
    throw new Error('Aiden Codex reasoning config requires no selected Codex profile');
  }
  root = root.replace(/^\s*model_reasoning_effort\s*=.*(?:\r?\n|$)/m, '');
  root = `model_reasoning_effort = ${JSON.stringify(effort)}\n${root}`;
  if (!/^\s*sqlite_home\s*=/m.test(root)) root = `sqlite_home = ${JSON.stringify(source)}\n${root}`;
  // Keep resume and submit confirmation on the same files the old worker used.
  // Stable links also avoid copying credentials or overwriting concurrent history.
  for (const name of ['auth.json', 'installation_id', 'sessions', 'archived_sessions',
    'history.jsonl', 'session_index.jsonl', 'skills', 'plugins', 'rules', '.tmp']) {
    const link = join(target, name);
    const destination = join(source, name);
    try {
      const existing = lstatSync(link);
      if (!existing.isSymbolicLink() || readlinkSync(link) !== destination) {
        throw new Error(`Aiden Codex state link conflicts: ${name}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      symlinkSync(destination, link);
    }
  }
  writeSecureHostFileSync(join(target, 'config.toml'), `${root.trimEnd()}\n\n${tables}`);
  return target;
}
