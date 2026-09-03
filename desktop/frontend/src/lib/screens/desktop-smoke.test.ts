/**
 * Controlled-engine desktop smoke scenario: the mock bridge plays a full
 * run lifecycle exactly as the engine would (no real LLM, ever) while the
 * real App + shell UI runs on top:
 *
 *   engine.ready (boot) -> project open (snapshot) -> run.start acceptance
 *   -> run.started -> run.step_changed -> stream.delta x3 -> usage.updated
 *   -> stream.clear -> stream.delta x2 (round 2) -> chapter.updated
 *   -> run.completed -> snapshot refresh with the new chapter count
 *
 * The UI must show the completed state and both streamed rounds, with the
 * persisted round 1 still visible after stream.clear.
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
import { currentRoute, navigate } from '$lib/routes';
import {
  connectionState,
  disposeDesktop,
  initDesktop,
  projectSnapshot,
  runState,
  stream,
  usage,
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

/** The controlled engine: a tiny state machine scripted by the test. */
const engine = {
  started: false,
  running: false,
  completedChapters: 0,
  wordCount: 0,
  snapshot() {
    return {
      state: this.running ? 'running' : 'idle',
      status_label: this.running ? 'Writing…' : 'Idle',
      phase: 'drafting',
      flow: 'standard',
      book_title: 'Smoke Test Novel',
      total_chapters: 12,
      completed_chapters: this.completedChapters,
      total_word_count: this.wordCount,
      running: this.running,
      advance_mode: 'auto',
      total_input_tokens: 100,
      total_output_tokens: 200,
      total_cost_usd: 0.5,
      budget_limit_usd: 10,
    };
  },
};

function scriptEngine(): void {
  tauri.reply('desktop_status', READY_STATUS);
  tauri.reply('desktop_event_state', { session: 'sess-1', lastSequence: 0, sessionsSeen: 1, duplicatesDropped: 0, forwardedCount: 1, sessionChanges: 0 });
  tauri.reply('desktop_paths', { appDataDir: '/x', projectsDir: '/x', targetTriple: 't' });
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    const payload = (args as { payload?: Record<string, unknown> })?.payload ?? {};
    switch (method) {
      case 'project.snapshot':
        return engine.snapshot();
      case 'project.replay_events':
        return { replayed: 0, last_sequence: 0 };
      case 'usage.snapshot':
        return { usage: { runs: engine.started ? 1 : 0 } };
      case 'run.start':
        // Acceptance semantics: ok:true now, lifecycle via events.
        engine.started = true;
        engine.running = true;
        return { accepted: true, via: 'run.start' };
      default:
        return { ok: true, echo: payload };
    }
  });
}

let sequence = 0;
function emit(event: string, payload: Record<string, unknown> = {}): void {
  sequence += 1;
  tauri.emit('desktop://event', engineEvent(event, sequence, payload, 'sess-1') as ForwardedEvent);
}

beforeEach(async () => {
  tauri.reset();
  sequence = 0;
  engine.started = false;
  engine.running = false;
  engine.completedChapters = 0;
  engine.wordCount = 0;
  await disposeDesktop();
  cleanup();
  installBridgeMarker();
  currentRoute.set('overview');
});

describe('controlled-engine desktop smoke', () => {
  it('plays a full run lifecycle and the UI shows the completed state', async () => {
    scriptEngine();
    // App.svelte normally runs the handshake on mount; drive it directly so
    // the test owns the startup ordering.
    const boot = initDesktop();
    render(AppShell);
    await boot;

    // Boot: engine ready, project snapshot loaded (overview identity).
    await vi.waitFor(() => expect(get(connectionState)).toBe('ready'));
    await vi.waitFor(() => expect(get(projectSnapshot)?.book_title).toBe('Smoke Test Novel'));
    expect(screen.getByTestId('overview-identity').textContent).toContain('Smoke Test Novel');

    // User starts a run from the run controls with a goal.
    navigate('write');
    await vi.waitFor(() => expect(screen.getByTestId('write-screen')).toBeTruthy());
    await fireEvent.input(screen.getByTestId('run-goal-input'), {
      target: { value: 'draft chapter 1' },
    });
    await fireEvent.click(screen.getByTestId('run-control-start'));

    const starts = tauri
      .callsOf('desktop_request')
      .filter((c) => (c.args as { method?: string }).method === 'run.start');
    expect(starts).toHaveLength(1);
    expect((starts[0]!.args as { payload?: { goal?: string } }).payload?.goal).toBe('draft chapter 1');

    // Engine lifecycle events, in wire order.
    emit('run.started', { run_id: 'r-smoke', goal: 'draft chapter 1' });
    emit('run.step_changed', { step: 'outline' });
    emit('stream.delta', { text: '# Chapter 1\n\n', channel: 'prose' });
    emit('stream.delta', { text: 'The harbour lights came on one by one.\n\n', channel: 'prose' });
    emit('stream.delta', { text: 'Mara counted them from the rail.', channel: 'prose' });
    emit('usage.updated', { usage: { input_tokens: 100, output_tokens: 200 }, budget: { limit_usd: 10 } });

    // Mid-run: live streaming, one open round, running status everywhere.
    await vi.waitFor(() => expect(get(runState).status).toBe('running'));
    expect(screen.getByTestId('write-stream-live')).toBeTruthy();
    expect(screen.getAllByTestId('write-round')).toHaveLength(1);
    expect(get(stream).channels['prose']!.text).toContain('Mara counted them');
    expect(screen.getByTestId('run-facts').textContent).toContain('running');
    expect(screen.getByTestId('run-facts').textContent).toContain('outline');
    expect(get(usage).budget).toEqual({ limit_usd: 10 });

    // Worker round boundary: persisted round stays, new round opens.
    emit('stream.clear', { channel: 'prose', reason: 'worker round complete' });
    emit('stream.delta', { text: 'The keeper waved her in.', channel: 'prose' });
    await vi.waitFor(() => expect(screen.getAllByTestId('write-round')).toHaveLength(2));
    const rounds = screen.getAllByTestId('write-round');
    expect(rounds[0]!.textContent).toContain('The harbour lights came on one by one.');
    expect(rounds[0]!.textContent).toContain('cleared: worker round complete');
    expect(rounds[1]!.textContent).toContain('The keeper waved her in.');

    // Chapter commit + terminal completion; the engine's own counters move.
    engine.running = false;
    engine.completedChapters = 1;
    engine.wordCount = 1500;
    emit('chapter.updated', { chapter: 1, status: 'saved' });
    emit('run.completed', { summary: { chapters: 1 } });

    // Terminal event triggers the snapshot refresh (engine is authoritative).
    await vi.waitFor(() => expect(get(runState).status).toBe('completed'));
    await vi.waitFor(() => expect(get(projectSnapshot)?.completed_chapters).toBe(1));

    // The Write screen shows the closed rounds; Overview shows completion.
    expect(screen.queryByTestId('write-stream-live')).toBeNull();
    navigate('overview');
    await vi.waitFor(() => expect(screen.getByTestId('overview-screen')).toBeTruthy());
    await vi.waitFor(() => expect(screen.getByTestId('overview-run-status').textContent).toContain('completed'));
    expect(screen.getByTestId('overview-run-terminal').textContent).toContain('run completed');
    expect(screen.getByTestId('overview-chapters').textContent).toBe('1/12');
    expect(screen.getByTestId('overview-budget-amount').textContent).toBe('$0.50 of $10.00');

    // No error surfaced anywhere in the happy path.
    expect(screen.getByTestId('overview-no-errors')).toBeTruthy();
  });
});
