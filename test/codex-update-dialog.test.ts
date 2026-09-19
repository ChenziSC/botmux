import { describe, expect, it } from 'vitest';
import { CodexUpdateDialogGuard, codexUpdatePickerKey, dismissCodexUpdatePicker } from '../src/utils/codex-update-dialog.js';

describe('CodexUpdateDialogGuard', () => {
  it('detects the numbered Update now / Skip picker through ANSI', () => {
    const guard = new CodexUpdateDialogGuard();
    const menu = '\x1b[1;1H› 1. Update now\x1b[2;3H2. Skip';

    expect(guard.inspect(menu)).toBe('dismiss');
    expect(guard.inspect(menu)).toBe('suppress');
  });

  it('detects the newer Remind me later wording across PTY chunks', () => {
    const guard = new CodexUpdateDialogGuard();

    expect(guard.inspect('\x1b[4;3HUpdate now (runs `npm install')).toBe('pass');
    expect(guard.inspect('\x1b[5;3HRemind me later')).toBe('dismiss');
  });

  it('does not mistake the normal composer for an update picker', () => {
    const guard = new CodexUpdateDialogGuard();

    expect(guard.inspect('\x1b[10;1H›\x1b[10;3HWrite tests for @filename')).toBe('pass');
  });

  it('can be reset for a fresh CLI spawn', () => {
    const guard = new CodexUpdateDialogGuard();
    const menu = '› 1. Update now\n  2. Skip';

    expect(guard.inspect(menu)).toBe('dismiss');
    guard.reset();
    expect(guard.inspect(menu)).toBe('dismiss');
  });
});


describe('startup update picker recovery', () => {
  const menu = (selected: number) => `Update available!\n${selected === 1 ? '›' : ' '} 1. Update now (runs npm install)\n${selected === 2 ? '›' : ' '} 2. Skip\n  3. Skip until next version\nPress enter to continue`;

  it('submits only an observed safe selection', () => {
    expect(codexUpdatePickerKey(menu(1))).toBe('Down');
    expect(codexUpdatePickerKey(menu(2))).toBe('Enter');
    expect(codexUpdatePickerKey(menu(1).replace('Press enter to continue', ''))).toBe('wait');
    expect(codexUpdatePickerKey(menu(1).replace('›', ' '))).toBe('wait');
    expect(codexUpdatePickerKey('› Ask Codex to do anything')).toBe('gone');
  });

  it('recovers dropped navigation and submit inputs using fresh screen observations', async () => {
    let screen = menu(1);
    const keys: string[] = [];
    const pauses: number[] = [];
    let down = 0;
    let enter = 0;
    const result = await dismissCodexUpdatePicker({
      isCurrent: () => true,
      capture: () => screen,
      pause: async ms => { pauses.push(ms); },
      send: key => {
        expect(pauses.length).toBeGreaterThan(keys.length);
        keys.push(key);
        if (key === 'Down' && ++down === 2) screen = menu(2);
        if (key === 'Enter' && ++enter === 2) screen = '› Ask Codex to do anything';
      },
    });
    expect(result).toBe('closed');
    expect(keys).toEqual(['Down', 'Down', 'Enter', 'Enter']);
    expect(pauses.every(ms => ms === 400)).toBe(true);
  });

  it('does not send delayed input across a backend generation change', async () => {
    let current = true;
    const keys: string[] = [];
    const result = await dismissCodexUpdatePicker({
      isCurrent: () => current,
      capture: () => menu(1),
      pause: async () => { current = false; },
      send: key => { keys.push(key); },
    });
    expect(result).toBe('cancelled');
    expect(keys).toEqual([]);
  });

  it('stops after a transport rejection and never follows it with Enter', async () => {
    const keys: string[] = [];
    const result = await dismissCodexUpdatePicker({
      isCurrent: () => true,
      capture: () => menu(1),
      pause: async () => {},
      send: key => { keys.push(key); return false; },
    });
    expect(result).toBe('input_rejected');
    expect(keys).toEqual(['Down']);
  });

  it('bounds retries and never submits an unconfirmed selection', async () => {
    const keys: string[] = [];
    const result = await dismissCodexUpdatePicker({
      isCurrent: () => true,
      capture: () => menu(1),
      pause: async () => {},
      send: key => { keys.push(key); },
    });
    expect(result).toBe('unconfirmed');
    expect(keys).toEqual(Array(8).fill('Down'));
  });
});
