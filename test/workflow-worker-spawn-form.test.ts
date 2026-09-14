import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return { ...actual, fork: vi.fn(), spawn: vi.fn() };
});

import { fork, spawn } from 'node:child_process';
import { forkWorkerJsFactory } from '../src/workflows/shared/worker-process.js';

const forkMock = vi.mocked(fork);
const spawnMock = vi.mocked(spawn);
const REAL_ARGV1 = process.argv[1];

function fakeChild(): any {
  const child = new EventEmitter() as any;
  child.send = vi.fn();
  child.kill = vi.fn();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('workflow worker process factory', () => {
  beforeEach(() => {
    forkMock.mockReset();
    spawnMock.mockReset();
    forkMock.mockReturnValue(fakeChild());
    spawnMock.mockReturnValue(fakeChild());
  });

  afterEach(() => {
    process.argv[1] = REAL_ARGV1;
  });

  it('forks the exact supplied worker module in Node/source mode', () => {
    process.argv[1] = '/repo/dist/cli.js';
    forkWorkerJsFactory.spawn({
      workerPath: '/custom/dist/workflow-worker.js',
      cwd: '/worktree',
      env: { TEST_ENV: 'source' },
    });

    expect(forkMock).toHaveBeenCalledOnce();
    expect(forkMock.mock.calls[0]?.[0]).toBe('/custom/dist/workflow-worker.js');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('re-enters a compiled Botmux binary with __worker and IPC', () => {
    process.argv[1] = '/$bunfs/root/cli.js';
    forkWorkerJsFactory.spawn({
      workerPath: '/$bunfs/root/worker.js',
      cwd: '/worktree',
      env: { TEST_ENV: 'compiled' },
    });

    expect(forkMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]?.[0]).toBe(process.execPath);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['__worker']);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      cwd: '/worktree',
      env: { TEST_ENV: 'compiled' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  });
});
