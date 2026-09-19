import { stripAnsiForLog } from './crash-log.js';

export type CodexUpdateDialogAction = 'pass' | 'dismiss' | 'suppress';

/**
 * Detect Codex's startup update picker across PTY chunks.
 *
 * Most launches disable the picker with `check_for_update_on_startup=false`.
 * Aiden is the exception: its `aiden x codex` launcher rejects every Codex
 * `-c` / `--config` override, so the worker needs a narrow compatibility
 * fallback. The picker has used both "Skip" and "Remind me later" for its
 * non-upgrade choice across Codex releases.
 */
export class CodexUpdateDialogGuard {
  private tail = '';
  private dismissed = false;

  inspect(data: string): CodexUpdateDialogAction {
    const plain = stripAnsiForLog(data).replace(/\s+/g, '').toLowerCase();
    this.tail = (this.tail + plain).slice(-4_096);

    const hasUpdateChoice = this.tail.includes('updatenow');
    const hasDeferredChoice = this.tail.includes('skip') || this.tail.includes('remindmelater');
    if (!hasUpdateChoice || !hasDeferredChoice) return 'pass';

    // Start fresh so a later real composer redraw cannot inherit menu words.
    this.tail = '';
    if (this.dismissed) return 'suppress';
    this.dismissed = true;
    return 'dismiss';
  }

  reset(): void {
    this.tail = '';
    this.dismissed = false;
  }
}


export type CodexUpdatePickerKey = 'Down' | 'Enter' | 'wait' | 'gone';

/** Inspect the current viewport, never a concatenation of old redraws. */
export function codexUpdatePickerKey(screen: string): CodexUpdatePickerKey {
  const plain = stripAnsiForLog(screen);
  if (!/Update available|Update now/i.test(plain)) return 'gone';
  if (!/Press enter to continue/i.test(plain)) return 'wait';
  const selected = plain.match(/^[ \t]*[›❯>][ \t]*\d+\.[ \t]*([^\r\n]+)/m)?.[1]?.trim();
  if (!selected) return 'wait';
  // Never submit the default upgrade row. Observe the safe selection first.
  if (/^(?:Skip(?: until next version)?|Remind me later)$/i.test(selected)) return 'Enter';
  if (/^Update now(?:\s|$)/i.test(selected)
    && /^[ \t]*\d+\.[ \t]*(?:Skip|Remind me later)/mi.test(plain)) return 'Down';
  return 'wait';
}

export interface CodexUpdatePickerDriver {
  isCurrent(): boolean;
  capture(): string;
  send(key: 'Down' | 'Enter'): void | boolean;
  pause?(ms: number): Promise<void>;
}

/** Bounded recovery for startup input that was dropped before the TUI was ready. */
export async function dismissCodexUpdatePicker(driver: CodexUpdatePickerDriver): Promise<string> {
  const pause = driver.pause ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await pause(400);
    if (!driver.isCurrent()) return 'cancelled';
    const key = codexUpdatePickerKey(driver.capture());
    if (key === 'gone') return 'closed';
    if (key === 'wait') continue;
    if (driver.send(key) === false) return 'input_rejected';
  }
  return 'unconfirmed';
}
