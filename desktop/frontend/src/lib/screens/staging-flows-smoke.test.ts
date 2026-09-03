/**
 * Controlled-engine smoke flows for the task-7 features (no real LLM, ever):
 * the mock bridge plays the daemon exactly as it would while the real
 * AppShell + screens run on top.
 *
 *   1. Co-create: start acceptance → thinking/reply previews → terminal
 *      assistant reply with staged draft + suggestions → resume → run.started.
 *   2. Import: native file pick → acceptance → ingesting/segmenting progress
 *      → done (continued) → snapshot refresh shows the published chapters.
 *   3. Simulation: native folder pick → acceptance (engine corpus dir) →
 *      scan/analyze progress → done profile summary → profile import over
 *      the shared event channel.
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
vi.mock('@tauri-apps/plugin-dialog', async () => {
  const { dialogMock } = await import('$tests/dialog-mock');
  return {
    open: (options: unknown) => dialogMock.open(options as never),
    save: (options: unknown) => dialogMock.save(options as never),
  };
});

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { get } from 'svelte/store';

import AppShell from '$lib/components/AppShell.svelte';
import { resetCocreateState } from '$lib/cocreate';
import { resetImportState } from '$lib/imports';
import { currentRoute, navigate } from '$lib/routes';
import { resetSimulationState } from '$lib/simulation';
import {
  connectionState,
  disposeDesktop,
  initDesktop,
  projectSnapshot,
  runState,
} from '$lib/stores/desktop';
import { dialogMock } from '$tests/dialog-mock';
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

/** The controlled engine: scripted state the smoke flow advances by hand. */
const engine = {
  completedChapters: 3,
  cocreateAccepted: 0,
  snapshot() {
    return {
      state: 'idle',
      status_label: 'Idle',
      book_title: 'Smoke Test Novel',
      total_chapters: 12,
      completed_chapters: this.completedChapters,
      running: false,
      advance_mode: 'auto',
    };
  },
};

function scriptEngine(): void {
  tauri.reply('desktop_status', READY_STATUS);
  tauri.reply('desktop_event_state', { session: 'sess-1', lastSequence: 0, sessionsSeen: 1, duplicatesDropped: 0, forwardedCount: 1, sessionChanges: 0 });
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    const payload = (args as { payload?: Record<string, unknown> })?.payload ?? {};
    switch (method) {
      case 'project.snapshot':
        return engine.snapshot();
      case 'project.replay_events':
        return { replayed: 0, last_sequence: 0 };
      case 'usage.snapshot':
        return { usage: {} };
      case 'cocreate.start':
        engine.cocreateAccepted += 1;
        return { accepted: true, mode: payload.mode === 'stage' ? 'stage' : 'cold' };
      case 'cocreate.stage':
        return { accepted: true, mode: 'cold' };
      case 'cocreate.resume':
        return { accepted: true, mode: 'cold', run_id: 'run-cocreate' };
      case 'import.start':
        return { accepted: true, source_path: payload.source_path };
      case 'import.resume':
        return { accepted: true, source_path: '' };
      case 'import.cancel':
        return { cancelled: true };
      case 'simulation.start':
        return { accepted: true, source_path: payload.source_path, engine_source_dir: '/projects/smoke/simulate' };
      case 'simulation.resume':
        return { accepted: true, source_path: '', engine_source_dir: '/projects/smoke/simulate' };
      case 'simulation.cancel':
        return { cancelled: true };
      case 'simulation.profile_import':
        return { accepted: true, profile_path: payload.profile_path };
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

function methodCalls(method: string): Array<Record<string, unknown> | undefined> {
  return tauri
    .callsOf('desktop_request')
    .filter((c) => (c.args as { method?: string })?.method === method)
    .map((c) => (c.args as { payload?: Record<string, unknown> })?.payload);
}

beforeEach(async () => {
  tauri.reset();
  dialogMock.reset();
  sequence = 0;
  engine.completedChapters = 3;
  engine.cocreateAccepted = 0;
  resetCocreateState();
  resetImportState();
  resetSimulationState();
  await disposeDesktop();
  cleanup();
  installBridgeMarker();
  currentRoute.set('overview');
});

describe('controlled-engine task-7 smoke flows', () => {
  it('co-create: chat round → staged draft → resume → run.started', async () => {
    scriptEngine();
    const boot = initDesktop();
    render(AppShell);
    await boot;
    await vi.waitFor(() => expect(get(connectionState)).toBe('ready'));

    navigate('cocreate');
    await vi.waitFor(() => expect(screen.getByTestId('cocreate-screen')).toBeTruthy());

    // Opening message (cold start).
    await fireEvent.input(screen.getByTestId('cocreate-message-input'), {
      target: { value: '我想写一部灯塔守夜人的悬疑小说' },
    });
    await fireEvent.click(screen.getByTestId('cocreate-send'));
    await vi.waitFor(() => expect(methodCalls('cocreate.start')).toHaveLength(1));
    expect(methodCalls('cocreate.start')[0]).toEqual({ message: '我想写一部灯塔守夜人的悬疑小说' });

    // Streaming previews (replace semantics), then the terminal reply.
    emit('cocreate.progress', { stage: 'thinking', message: '考虑基调' });
    emit('cocreate.progress', { stage: 'reply', message: 'What should the ending feel like?' });
    await vi.waitFor(() => expect(screen.getByTestId('cocreate-preview-reply').textContent).toContain('What should the ending feel like?'));

    emit('cocreate.progress', {
      stage: 'assistant',
      message: 'A quiet ending. The lamp outlasts the keeper.',
      ready: true,
      draft: '# 灯塔守夜人\n\n冷峻而克制的悬疑短篇。',
      suggestions: ['加一个对手守夜人'],
    });
    await vi.waitFor(() => expect(screen.getByTestId('cocreate-draft').textContent).toContain('冷峻而克制'));
    expect(screen.getByTestId('cocreate-turn-assistant').textContent).toContain('A quiet ending');
    expect(screen.getByTestId('cocreate-draft-ready')).toBeTruthy();

    // Resume hands the draft over; the engine answers with run.started.
    await fireEvent.click(screen.getByTestId('cocreate-resume'));
    await vi.waitFor(() => expect(methodCalls('cocreate.resume')).toHaveLength(1));
    emit('run.started', { run_id: 'run-cocreate', goal: '# 灯塔守夜人…' });
    await vi.waitFor(() => expect(get(runState).status).toBe('running'));
    expect(screen.getByTestId('cocreate-resumed-note').textContent).toContain('Write screen');
  });

  it('import: file pick → progress → published chapters appear in durable facts', async () => {
    scriptEngine();
    const boot = initDesktop();
    render(AppShell);
    await boot;
    await vi.waitFor(() => expect(get(connectionState)).toBe('ready'));

    navigate('import');
    await vi.waitFor(() => expect(screen.getByTestId('import-screen')).toBeTruthy());
    dialogMock.openImpl = async () => '/books/imported-novel.txt';

    await fireEvent.click(screen.getByTestId('import-run'));
    await vi.waitFor(() =>
      expect(methodCalls('import.start')[0]).toEqual({
        source_path: '/books/imported-novel.txt',
        options: { auto_confirm: true, continue_after: false },
      }),
    );
    await vi.waitFor(() => expect(screen.getByTestId('import-status').textContent).toBe('importing…'));

    emit('import.progress', { stage: 'ingesting', completed: 0, total: 1, detail: 'decoding utf-8' });
    emit('import.progress', { stage: 'segmenting', completed: 1, total: 1, detail: 'found 9 chapters' });
    await vi.waitFor(() => expect(screen.getByTestId('import-recent').textContent).toContain('found 9 chapters'));

    // The engine publishes and its own counters move; done carries continued.
    engine.completedChapters = 9;
    emit('import.progress', { stage: 'done', completed: 1, total: 1, detail: 'published', continued: true });

    await vi.waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(screen.getByTestId('import-result-continued')).toBeTruthy();
    // Durable facts refreshed from the engine's authoritative snapshot.
    await vi.waitFor(() => expect(get(projectSnapshot)?.completed_chapters).toBe(9));
    expect(screen.getByTestId('import-facts').textContent).toContain('9/12');
  });

  it('simulation: folder corpus → generated profile summary → profile import', async () => {
    scriptEngine();
    const boot = initDesktop();
    render(AppShell);
    await boot;
    await vi.waitFor(() => expect(get(connectionState)).toBe('ready'));

    navigate('simulation');
    await vi.waitFor(() => expect(screen.getByTestId('simulation-screen')).toBeTruthy());
    dialogMock.openImpl = async (options) => (options.directory ? '/books/style-corpus' : '/profiles/generated.json');

    await fireEvent.click(screen.getByTestId('simulation-run-directory'));
    await vi.waitFor(() =>
      expect(methodCalls('simulation.start')[0]).toEqual({ source_path: '/books/style-corpus' }),
    );
    await vi.waitFor(() => expect(screen.getByTestId('simulation-status').textContent).toBe('simulating…'));
    expect(screen.getByTestId('simulation-corpus-dir').textContent).toContain('/projects/smoke/simulate');

    emit('simulation.progress', { stage: 'scan', completed: 2, total: 6, detail: 'scanning corpus' });
    emit('simulation.progress', { stage: 'analyze', completed: 6, total: 6, detail: 'analyzing voice' });
    await vi.waitFor(() => expect(screen.getByTestId('simulation-progress').textContent).toContain('analyze'));

    emit('simulation.progress', { stage: 'done', detail: '仿写画像已更新：新增/变更 6 篇，累计 6 篇' });
    await vi.waitFor(() => expect(screen.getByTestId('simulation-result')).toBeTruthy());
    expect(screen.getByTestId('simulation-generated').textContent).toContain('仿写画像已更新');

    // Profile import over the same event channel.
    await fireEvent.click(screen.getByTestId('simulation-profile-import'));
    await vi.waitFor(() =>
      expect(methodCalls('simulation.profile_import')[0]).toEqual({ profile_path: '/profiles/generated.json' }),
    );
    emit('simulation.progress', { stage: 'done', detail: 'profile imported' });
    await vi.waitFor(() => expect(screen.getByTestId('simulation-profile-done').textContent).toContain('profile imported'));
    // The simulation run was already terminal; the run status must not flip.
    expect(screen.getByTestId('simulation-status').textContent).toBe('completed');
  });
});
