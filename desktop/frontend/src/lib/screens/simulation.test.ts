/**
 * Simulation screen tests: file/directory source pickers (engine corpus
 * filters), corpus dir display, progress/terminals, generated (staged) vs
 * durable distinction, resume (no corpus -> engine error), cancel, and the
 * profile import flow.
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

import SimulationScreen from '$lib/screens/SimulationScreen.svelte';
import { resetSimulationState } from '$lib/simulation';
import {
  applyEngineEvent,
  connectionState,
  disposeDesktop,
  projectSnapshot,
} from '$lib/stores/desktop';
import { dialogMock } from '$tests/dialog-mock';
import { engineEvent, installBridgeMarker, tauri } from '$tests/tauri-mock';
import type { EventEnvelope } from '$lib/types/protocol';

const SNAPSHOT = {
  state: 'idle',
  book_title: 'The Lantern Sea',
  total_chapters: 12,
  completed_chapters: 3,
};
const CORPUS = '/projects/demo/simulate';

function apply(event: string, sequence: number, payload: Record<string, unknown> = {}): void {
  applyEngineEvent(engineEvent(event, sequence, payload, 'sess-1') as unknown as EventEnvelope);
}

function payloadOf(method: string): Record<string, unknown> | undefined {
  const call = tauri
    .callsOf('desktop_request')
    .find((c) => (c.args as { method?: string })?.method === method);
  return (call?.args as { payload?: Record<string, unknown> })?.payload;
}

function scriptEngine(): void {
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    switch (method) {
      case 'project.snapshot':
        return { ...SNAPSHOT };
      case 'simulation.start':
        return { accepted: true, source_path: '/books/reference.txt', engine_source_dir: CORPUS };
      case 'simulation.resume':
        return { accepted: true, source_path: '', engine_source_dir: CORPUS };
      case 'simulation.profile_import':
        return { accepted: true, profile_path: '/profiles/style.json' };
      default:
        return { accepted: true };
    }
  });
}

function renderScreen(): void {
  render(SimulationScreen, { props: { title: 'Simulation', description: 'Simulation screen', owner: 'task 7' } });
}

beforeEach(async () => {
  tauri.reset();
  dialogMock.reset();
  resetSimulationState();
  await disposeDesktop();
  cleanup();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
});

describe('simulation screen', () => {
  it('no project open: empty state', () => {
    projectSnapshot.set(null);
    renderScreen();
    expect(screen.getByTestId('simulation-empty')).toBeTruthy();
    expect(screen.queryByTestId('simulation-form')).toBeNull();
  });

  it('generated-content banner and durable facts pane are distinct', () => {
    renderScreen();
    expect(screen.getByTestId('simulation-staged-note').textContent).toContain('generated');
    expect(screen.getByTestId('simulation-generated').querySelector('.staged-badge')).toBeTruthy();
    expect(screen.getByTestId('simulation-facts').textContent).toContain('durable');
    expect(screen.getByTestId('simulation-facts').textContent).toContain('The Lantern Sea');
  });

  it('file source: corpus filter, verbatim path, engine corpus dir shown', async () => {
    scriptEngine();
    dialogMock.openImpl = async (options) => {
      expect(options.filters?.[0]?.extensions).toContain('markdown');
      return '/books/reference.txt';
    };
    renderScreen();

    await fireEvent.click(screen.getByTestId('simulation-run-file'));
    await vi.waitFor(() =>
      expect(payloadOf('simulation.start')).toEqual({ source_path: '/books/reference.txt' }),
    );
    await vi.waitFor(() => expect(screen.getByTestId('simulation-status').textContent).toBe('simulating…'));
    expect(screen.getByTestId('simulation-corpus-dir').textContent).toContain(CORPUS);
  });

  it('directory source opens the directory picker', async () => {
    scriptEngine();
    dialogMock.openImpl = async (options) => {
      expect(options.directory).toBe(true);
      return '/books/corpus-folder';
    };
    renderScreen();

    await fireEvent.click(screen.getByTestId('simulation-run-directory'));
    await vi.waitFor(() =>
      expect(payloadOf('simulation.start')).toEqual({ source_path: '/books/corpus-folder' }),
    );
  });

  it('cancelled pickers send nothing', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => null;
    renderScreen();

    await fireEvent.click(screen.getByTestId('simulation-run-file'));
    await vi.waitFor(() => expect(dialogMock.openCalls).toHaveLength(1));
    expect(tauri.callsOf('desktop_request').filter((c) => (c.args as { method?: string }).method === 'simulation.start')).toHaveLength(0);
    expect(screen.getByTestId('simulation-no-result')).toBeTruthy();
  });

  it('progress renders; terminal done shows the generated profile summary', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/reference.txt';
    renderScreen();
    await fireEvent.click(screen.getByTestId('simulation-run-file'));
    await vi.waitFor(() => expect(screen.getByTestId('simulation-status').textContent).toBe('simulating…'));

    apply('simulation.progress', 2, { stage: 'scan', completed: 2, total: 5, detail: 'scanning' });
    await vi.waitFor(() => expect(screen.getByTestId('simulation-progress').textContent).toContain('scan'));
    expect(screen.getByTestId('simulation-recent').textContent).toContain('scanning');

    apply('simulation.progress', 3, { stage: 'done', detail: '仿写画像已更新：新增/变更 5 篇' });
    await vi.waitFor(() => expect(screen.getByTestId('simulation-result')).toBeTruthy());
    expect(screen.getByTestId('simulation-status').textContent).toBe('completed');
    expect(screen.getByTestId('simulation-result-detail').textContent).toContain('仿写画像已更新');
    expect(screen.getByTestId('simulation-generated').textContent).toContain('content fingerprint');
  });

  it('a stage failure shows the structured error', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/reference.txt';
    renderScreen();
    await fireEvent.click(screen.getByTestId('simulation-run-file'));
    await vi.waitFor(() => expect(screen.getByTestId('simulation-status').textContent).toBe('simulating…'));

    apply('simulation.progress', 2, { stage: 'analyze', error: 'llm unavailable' });
    await vi.waitFor(() => expect(screen.getByTestId('simulation-error')).toBeTruthy());
    expect(screen.getByTestId('simulation-error').textContent).toContain('[operation_failed]');
  });

  it('resume without a staged corpus surfaces the engine rejection', async () => {
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'simulation.resume') {
        throw {
          code: 'operation_failed',
          message: 'no simulation corpus staged in this project; start one with simulation.start {source_path}',
        };
      }
      return { accepted: true };
    });
    renderScreen();

    await fireEvent.click(screen.getByTestId('simulation-resume'));
    await vi.waitFor(() => expect(screen.getByTestId('simulation-error')).toBeTruthy());
    expect(screen.getByTestId('simulation-error').textContent).toContain('no simulation corpus staged');
  });

  it('cancel is offered while running; cancelled:false keeps the run and shows the reason', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/reference.txt';
    renderScreen();
    await fireEvent.click(screen.getByTestId('simulation-run-file'));
    expect(screen.getByTestId('simulation-cancel').hasAttribute('disabled')).toBe(true);

    apply('simulation.progress', 2, { stage: 'scan', detail: 'scanning' });
    await vi.waitFor(() => expect(screen.getByTestId('simulation-cancel').hasAttribute('disabled')).toBe(false));

    tauri.reply('desktop_request', { cancelled: false, reason: 'no simulation in progress' });
    await fireEvent.click(screen.getByTestId('simulation-cancel'));
    await vi.waitFor(() =>
      expect(screen.getByTestId('simulation-message').textContent).toContain('no simulation in progress'),
    );
    expect(screen.getByTestId('simulation-status').textContent).toBe('simulating…');
  });

  it('profile import: json filter, request payload, terminal completes the profile flow', async () => {
    scriptEngine();
    dialogMock.openImpl = async (options) => {
      expect(options.filters?.[0]?.extensions).toContain('json');
      return '/profiles/style.json';
    };
    renderScreen();

    await fireEvent.click(screen.getByTestId('simulation-profile-import'));
    await vi.waitFor(() =>
      expect(payloadOf('simulation.profile_import')).toEqual({ profile_path: '/profiles/style.json' }),
    );
    await vi.waitFor(() =>
      expect(screen.getByTestId('simulation-profile-path').textContent).toContain('/profiles/style.json'),
    );

    // Shared event channel: the terminal completes the PROFILE flow only.
    apply('simulation.progress', 2, { stage: 'done', detail: 'profile imported' });
    await vi.waitFor(() => expect(screen.getByTestId('simulation-profile-done').textContent).toContain('profile imported'));
    expect(screen.getByTestId('simulation-status').textContent).toBe('idle');
  });

  it('an inaccessible profile shows the structured error', async () => {
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'simulation.profile_import') {
        throw { code: 'operation_failed', message: 'profile file not accessible' };
      }
      return { accepted: true };
    });
    dialogMock.openImpl = async () => '/x/missing.json';
    renderScreen();

    await fireEvent.click(screen.getByTestId('simulation-profile-import'));
    await vi.waitFor(() => expect(screen.getByTestId('simulation-profile-error')).toBeTruthy());
    expect(screen.getByTestId('simulation-profile-error').textContent).toContain('profile file not accessible');
  });
});
