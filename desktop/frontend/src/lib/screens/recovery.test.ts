/**
 * Recovery choice tests: after an engine session change that interrupts
 * observed work, the UI demands an explicit resume / inspect / close
 * decision. Resume sends `project.resume` with NO checkpoint id (the engine
 * always resumes latest and rejects explicit ids); the engine's run.started
 * clears the prompt; a rejected resume keeps the prompt up.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () => {
  const { tauri } = await import('$tests/tauri-mock');
  return { invoke: (cmd: string, args?: Record<string, unknown>) => tauri.invoke(cmd, args) };
});
vi.mock('@tauri-apps/api/event', async () => {
  const { tauri } = await import('$tests/tauri-mock');
  return {
    listen: (name: string, handler: (event: { event: string; payload: unknown }) => void) =>
      tauri.listen(name, handler),
  };
});

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { get } from 'svelte/store';

import AppShell from '$lib/components/AppShell.svelte';
import {
  connectionState,
  disposeDesktop,
  initDesktop,
  notifications,
  projectSnapshot,
  recoveryPrompt,
  runState,
} from '$lib/stores/desktop';
import { engineEvent, installBridgeMarker, tauri } from '$tests/tauri-mock';
import type { ForwardedEvent } from '$lib/types/protocol';

const READY_STATUS = {
  provider: 'go-sidecar',
  protocol: 'desktop-v1',
  health: 'ready',
  stopping: false,
  session: 'sess-1',
  pid: 4242,
  restartAttempts: 0,
  restartsTotal: 0,
  malformedOutputLines: 0,
  stderrLines: 0,
  lastError: null,
  lastExitCode: null,
};

const SNAPSHOT = {
  state: 'paused',
  status_label: 'Paused',
  book_title: 'Test Novel',
  total_chapters: 12,
  completed_chapters: 3,
  recovery_label: 'Interrupted run — resume available',
};

function scriptEngine(): void {
  tauri.reply('desktop_status', READY_STATUS);
  tauri.reply('desktop_event_state', { session: 'sess-1', lastSequence: 0, sessionsSeen: 1, duplicatesDropped: 0, forwardedCount: 1, sessionChanges: 0 });
  tauri.reply('desktop_paths', { appDataDir: '/x', projectsDir: '/x', targetTriple: 't' });
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    if (method === 'project.snapshot') return { ...SNAPSHOT };
    if (method === 'project.replay_events') return { replayed: 0, last_sequence: 0 };
    if (method === 'usage.snapshot') return { usage: {} };
    if (method === 'project.resume') return { resumed: true };
    if (method === 'project.close') return { closed: true };
    throw { code: 'unknown_method', message: `unexpected ${method}` };
  });
}

function requestPayloadsOf(method: string): Array<Record<string, unknown> | undefined> {
  return tauri
    .callsOf('desktop_request')
    .filter((call) => (call.args as { method?: string })?.method === method)
    .map((call) => call.args?.payload as Record<string, unknown> | undefined);
}

async function bootWithProjectAndActiveRun(): Promise<void> {
  scriptEngine();
  await initDesktop();
  await vi.waitFor(() => expect(get(connectionState)).toBe('ready'));
  await vi.waitFor(() => expect(get(projectSnapshot)).not.toBeNull());
  tauri.emit('desktop://event', engineEvent('run.started', 5, { run_id: 'r-1' }, 'sess-1') as ForwardedEvent);
  await vi.waitFor(() => expect(get(runState).status).toBe('running'));
}

function sessionChange(): void {
  tauri.emit('desktop://session', { previous: 'sess-1', current: 'sess-2', lastSequence: 5 });
}

beforeEach(async () => {
  tauri.reset();
  await disposeDesktop();
  cleanup();
  installBridgeMarker();
});

describe('explicit recovery choice', () => {
  it('session change with an active run raises the prompt; no engine mutation is issued', async () => {
    await bootWithProjectAndActiveRun();
    render(AppShell);

    expect(screen.queryByTestId('recovery-card')).toBeNull();
    sessionChange();
    await vi.waitFor(() => expect(screen.getByTestId('recovery-card')).toBeTruthy());

    // Observed run state reset; nothing resumed on our own initiative.
    expect(get(runState).status).toBe('idle');
    expect(requestPayloadsOf('project.resume')).toEqual([]);
    expect(screen.getByTestId('recovery-card').textContent).toMatch(/run\s+was\s+running/);
  });

  it('session change with no project and no run does not raise the prompt', async () => {
    scriptEngine();
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'project.snapshot') throw { code: 'project_unavailable', message: 'no project open' };
      if (method === 'project.replay_events') return { replayed: 0 };
      if (method === 'usage.snapshot') return {};
      throw { code: 'unknown_method', message: 'x' };
    });
    await initDesktop();
    await vi.waitFor(() => expect(get(connectionState)).toBe('ready'));
    render(AppShell);

    sessionChange();
    await vi.waitFor(() => expect(get(runState).status).toBe('idle'));
    expect(get(recoveryPrompt)).toBeNull();
    expect(screen.queryByTestId('recovery-card')).toBeNull();
  });

  it('resume sends project.resume with NO checkpoint_id and run.started clears the prompt', async () => {
    await bootWithProjectAndActiveRun();
    render(AppShell);
    sessionChange();
    await vi.waitFor(() => expect(screen.getByTestId('recovery-card')).toBeTruthy());

    await fireEvent.click(screen.getByTestId('recovery-resume'));
    await vi.waitFor(() => {
      expect(requestPayloadsOf('project.resume')).toEqual([{}]); // always-latest
    });

    // The engine confirms by emitting run.started under the new session.
    tauri.emit('desktop://event', engineEvent('run.started', 2, { run_id: 'r-2' }, 'sess-2') as ForwardedEvent);
    await vi.waitFor(() => expect(screen.queryByTestId('recovery-card')).toBeNull());
    expect(get(runState).status).toBe('running');
  });

  it('inspect dismisses the prompt without any engine command', async () => {
    await bootWithProjectAndActiveRun();
    render(AppShell);
    sessionChange();
    await vi.waitFor(() => expect(screen.getByTestId('recovery-card')).toBeTruthy());

    const requestsBefore = tauri.callsOf('desktop_request').length;
    await fireEvent.click(screen.getByTestId('recovery-inspect'));
    await vi.waitFor(() => expect(screen.queryByTestId('recovery-card')).toBeNull());
    expect(tauri.callsOf('desktop_request').length).toBe(requestsBefore);
    // State stays visible for inspection.
    expect(get(projectSnapshot)).not.toBeNull();
  });

  it('close sends project.close and returns to the empty state', async () => {
    await bootWithProjectAndActiveRun();
    render(AppShell);
    sessionChange();
    await vi.waitFor(() => expect(screen.getByTestId('recovery-card')).toBeTruthy());

    await fireEvent.click(screen.getByTestId('recovery-close'));
    await vi.waitFor(() => expect(requestPayloadsOf('project.close')).toEqual([{}]));
    await vi.waitFor(() => {
      expect(get(projectSnapshot)).toBeNull();
      expect(get(recoveryPrompt)).toBeNull();
    });
  });

  it('a rejected resume keeps the choice open and surfaces the structured error', async () => {
    await bootWithProjectAndActiveRun();
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'project.resume') {
        throw { code: 'host_busy', message: 'a generation run is already active' };
      }
      if (method === 'project.snapshot') return { ...SNAPSHOT };
      if (method === 'project.replay_events') return { replayed: 0 };
      if (method === 'usage.snapshot') return {};
      throw { code: 'unknown_method', message: 'x' };
    });
    render(AppShell);
    sessionChange();
    await vi.waitFor(() => expect(screen.getByTestId('recovery-card')).toBeTruthy());

    await fireEvent.click(screen.getByTestId('recovery-resume'));
    await vi.waitFor(() =>
      expect(get(notifications).some((n) => n.code === 'host_busy' && n.message.includes('Engine busy'))).toBe(true),
    );
    // The interruption is unresolved: the explicit choice stays.
    expect(screen.getByTestId('recovery-card')).toBeTruthy();
  });

  it('run.started (e.g. engine-authorized continuation) clears a stale prompt by itself', async () => {
    await bootWithProjectAndActiveRun();
    render(AppShell);
    sessionChange();
    await vi.waitFor(() => expect(screen.getByTestId('recovery-card')).toBeTruthy());

    tauri.emit('desktop://event', engineEvent('run.started', 2, { run_id: 'r-auto' }, 'sess-2') as ForwardedEvent);
    await vi.waitFor(() => expect(screen.queryByTestId('recovery-card')).toBeNull());
  });
});
