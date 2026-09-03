/**
 * Simulation controller tests: source staging semantics (file picker with
 * the engine's corpus filters, or a directory picker), acceptance capturing
 * the engine-reported corpus dir, progress/done/error structural terminals,
 * resume (and its no-corpus rejection), cancellation, profile import over
 * the shared simulation.progress channel, and projection resets.
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

import { get } from 'svelte/store';

import {
  cancelSimulationFromUi,
  dismissSimulationResult,
  importProfileFromUi,
  resetSimulationState,
  resumeSimulationFromUi,
  SIMULATION_PROFILE_FILTERS,
  SIMULATION_SOURCE_FILTERS,
  simulationState,
  startSimulationFromUi,
} from '$lib/simulation';
import {
  applyEngineEvent,
  connectionState,
  disposeDesktop,
  engineState,
  projectSnapshot,
} from '$lib/stores/desktop';
import { dialogMock } from '$tests/dialog-mock';
import { engineEvent, installBridgeMarker, tauri } from '$tests/tauri-mock';
import type { EventEnvelope, ProjectSnapshot } from '$lib/types/protocol';

const SNAPSHOT: ProjectSnapshot = { state: 'idle', book_title: 'Test Novel', total_chapters: 12 };
const CORPUS = '/projects/demo/simulate';

function payloadOf(method: string): Record<string, unknown> | undefined {
  const call = tauri
    .callsOf('desktop_request')
    .find((c) => (c.args as { method?: string })?.method === method);
  return (call?.args as { payload?: Record<string, unknown> })?.payload;
}

function apply(event: string, sequence: number, payload: Record<string, unknown> = {}): void {
  applyEngineEvent(engineEvent(event, sequence, payload, 'sess-1') as unknown as EventEnvelope);
}

beforeEach(async () => {
  tauri.reset();
  dialogMock.reset();
  resetSimulationState();
  await disposeDesktop();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
  engineState.set({ health: 'ready', stopping: false, restartAttempts: 0, restartsTotal: 0, malformedOutputLines: 0, session: 'sess-1' });
});

describe('simulation.start source staging', () => {
  it('file source: corpus-type filter, path forwarded verbatim, corpus dir adopted from the engine', async () => {
    tauri.reply('desktop_request', {
      accepted: true,
      source_path: '/books/reference.txt',
      engine_source_dir: CORPUS,
    });
    dialogMock.openImpl = async (options) => {
      expect(options.directory).toBe(false);
      return '/books/reference.txt';
    };
    const ok = await startSimulationFromUi('file');
    expect(ok).toBe(true);

    expect(dialogMock.openCalls[0]?.filters).toEqual(SIMULATION_SOURCE_FILTERS);
    expect(payloadOf('simulation.start')).toEqual({ source_path: '/books/reference.txt' });

    const s = get(simulationState);
    expect(s.status).toBe('running');
    expect(s.sourcePath).toBe('/books/reference.txt');
    expect(s.corpusDir).toBe(CORPUS);
  });

  it('directory source: directory picker (engine stages supported files recursively)', async () => {
    tauri.reply('desktop_request', { accepted: true, source_path: '/books/corpus', engine_source_dir: CORPUS });
    dialogMock.openImpl = async (options) => {
      expect(options.directory).toBe(true);
      return '/books/corpus';
    };
    const ok = await startSimulationFromUi('directory');
    expect(ok).toBe(true);
    expect(dialogMock.openCalls[0]?.directory).toBe(true);
    expect(payloadOf('simulation.start')).toEqual({ source_path: '/books/corpus' });
    expect(get(simulationState).corpusDir).toBe(CORPUS);
  });

  it('a cancelled picker sends nothing', async () => {
    dialogMock.openImpl = async () => null;
    expect(await startSimulationFromUi('file')).toBe(false);
    expect(tauri.callsOf('desktop_request')).toHaveLength(0);
    expect(get(simulationState).status).toBe('idle');
  });

  it('an unsupported single file is the engine rejection (operation_failed), surfaced structurally', async () => {
    tauri.fail('desktop_request', {
      code: 'operation_failed',
      message: 'simulation source must be a .txt/.md/.markdown file or a directory containing them: /x/pic.png',
    });
    dialogMock.openImpl = async () => '/x/pic.png';
    expect(await startSimulationFromUi('file')).toBe(false);
    const s = get(simulationState);
    expect(s.status).toBe('idle');
    expect(s.error?.code).toBe('operation_failed');
  });
});

describe('simulation.progress terminals (structural)', () => {
  async function running(): Promise<void> {
    tauri.reply('desktop_request', { accepted: true, source_path: '/books/reference.txt', engine_source_dir: CORPUS });
    dialogMock.openImpl = async () => '/books/reference.txt';
    await startSimulationFromUi('file');
  }

  it('progress facts project live stage/counts', async () => {
    await running();
    apply('simulation.progress', 2, { stage: 'scan', completed: 1, total: 4, detail: 'scanning corpus' });
    const s = get(simulationState);
    expect(s.status).toBe('running');
    expect(s.progress).toMatchObject({ stage: 'scan', completed: 1, total: 4 });
    expect(s.recent).toHaveLength(1);
  });

  it('stage:"done" completes with the engine-generated profile summary', async () => {
    await running();
    apply('simulation.progress', 2, { stage: 'done', completed: 4, total: 4, detail: '仿写画像已更新：新增/变更 4 篇，累计 9 篇' });
    const s = get(simulationState);
    expect(s.status).toBe('completed');
    expect(s.result?.detail).toContain('仿写画像已更新');
  });

  it('a payload error fact fails with operation_failed', async () => {
    await running();
    apply('simulation.progress', 2, { stage: 'analyze', error: 'llm unavailable' });
    const s = get(simulationState);
    expect(s.status).toBe('failed');
    expect(s.error?.message).toBe('llm unavailable');
  });
});

describe('simulation.resume / cancel', () => {
  it('resume re-runs the staged corpus with no payload', async () => {
    tauri.reply('desktop_request', { accepted: true, source_path: '', engine_source_dir: CORPUS });
    const ok = await resumeSimulationFromUi();
    expect(ok).toBe(true);
    expect(payloadOf('simulation.resume')).toEqual({});
    expect(get(simulationState).corpusDir).toBe(CORPUS);
  });

  it('resume without a staged corpus surfaces the engine rejection', async () => {
    tauri.fail('desktop_request', {
      code: 'operation_failed',
      message: 'no simulation corpus staged in this project; start one with simulation.start {source_path}',
    });
    expect(await resumeSimulationFromUi()).toBe(false);
    expect(get(simulationState).error?.code).toBe('operation_failed');
  });

  it('cancel answered cancelled:true stops; cancelled:false surfaces the reason', async () => {
    tauri.reply('desktop_request', { accepted: true, source_path: '/s', engine_source_dir: CORPUS });
    dialogMock.openImpl = async () => '/s';
    await startSimulationFromUi('file');

    tauri.reply('desktop_request', { cancelled: true });
    expect(await cancelSimulationFromUi()).toBe(true);
    expect(payloadOf('simulation.cancel')).toEqual({});
    expect(get(simulationState).status).toBe('cancelled');

    // A second cancel: nothing running engine-side.
    resetSimulationState();
    tauri.reply('desktop_request', { accepted: true, source_path: '/s', engine_source_dir: CORPUS });
    dialogMock.openImpl = async () => '/s';
    await startSimulationFromUi('file');
    tauri.reply('desktop_request', { cancelled: false, reason: 'no simulation in progress' });
    await cancelSimulationFromUi();
    expect(get(simulationState).status).toBe('running');
    expect(get(simulationState).message).toBe('no simulation in progress');
  });
});

describe('simulation.profile_import (shared event channel)', () => {
  it('picks a profile JSON, imports it, and the terminal done completes the profile flow only', async () => {
    tauri.reply('desktop_request', { accepted: true, profile_path: '/profiles/style.json' });
    dialogMock.openImpl = async (options) => {
      expect(options.filters).toEqual(SIMULATION_PROFILE_FILTERS);
      return '/profiles/style.json';
    };
    const ok = await importProfileFromUi();
    expect(ok).toBe(true);
    expect(payloadOf('simulation.profile_import')).toEqual({ profile_path: '/profiles/style.json' });
    expect(get(simulationState).profileImport).toMatchObject({ status: 'importing', profilePath: '/profiles/style.json' });
    // The simulation run itself was never active.
    expect(get(simulationState).status).toBe('idle');

    apply('simulation.progress', 2, { stage: 'done', detail: 'profile imported' });
    expect(get(simulationState).profileImport).toMatchObject({ status: 'completed', detail: 'profile imported' });
    expect(get(simulationState).status).toBe('idle');
  });

  it('a cancelled profile picker sends nothing', async () => {
    dialogMock.openImpl = async () => null;
    expect(await importProfileFromUi()).toBe(false);
    expect(tauri.callsOf('desktop_request')).toHaveLength(0);
    expect(get(simulationState).profileImport.status).toBe('idle');
  });

  it('an inaccessible profile surfaces the structured error', async () => {
    tauri.fail('desktop_request', { code: 'operation_failed', message: 'profile file not accessible' });
    dialogMock.openImpl = async () => '/x/missing.json';
    expect(await importProfileFromUi()).toBe(false);
    expect(get(simulationState).profileImport.error?.code).toBe('operation_failed');
  });
});

describe('resets', () => {
  it('a done event beating the profile acceptance does not reopen the import', async () => {
    let release: (value: unknown) => void = () => {};
    let requestInFlight = false;
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'simulation.profile_import') {
        requestInFlight = true;
        return new Promise((resolve) => {
          release = resolve as (value: unknown) => void;
        });
      }
      return { accepted: true };
    });
    dialogMock.openImpl = async () => '/profiles/style.json';

    const pending = importProfileFromUi();
    await vi.waitFor(() => expect(requestInFlight).toBe(true));
    apply('simulation.progress', 2, { stage: 'done', detail: 'profile imported' });
    release({ accepted: true, profile_path: '/profiles/style.json' });
    expect(await pending).toBe(true);

    expect(get(simulationState).profileImport).toMatchObject({
      status: 'completed',
      detail: 'profile imported',
      profilePath: '/profiles/style.json',
    });
    expect(get(simulationState).status).toBe('idle');
  });

  it('facts recorded before a project close are not replayed onto the next simulation (no disposeDesktop)', async () => {
    tauri.reply('desktop_request', { accepted: true, source_path: '/a.txt', engine_source_dir: CORPUS });
    dialogMock.openImpl = async () => '/a.txt';
    await startSimulationFromUi('file');
    apply('simulation.progress', 2, { stage: 'done', detail: 'first profile done' });
    expect(get(simulationState).status).toBe('completed');

    // Project closes WITHOUT disposeDesktop: the projection resets while the
    // shared fact store keeps its history.
    projectSnapshot.set(null);
    expect(get(simulationState).status).toBe('idle');

    // New project, new run: the old done fact must not complete it.
    projectSnapshot.set({ ...SNAPSHOT });
    tauri.reply('desktop_request', { accepted: true, source_path: '/b.txt', engine_source_dir: CORPUS });
    dialogMock.openImpl = async () => '/b.txt';
    await startSimulationFromUi('file');
    apply('simulation.progress', 3, { stage: 'scan', detail: 'scanning second corpus' });

    const s = get(simulationState);
    expect(s.status).toBe('running');
    expect(s.progress?.detail).toBe('scanning second corpus');
    expect(s.result).toBeNull();
  });

  it('an engine session change mid-run marks it interrupted (resume re-runs the corpus)', async () => {
    tauri.reply('desktop_request', { accepted: true, source_path: '/s', engine_source_dir: CORPUS });
    dialogMock.openImpl = async () => '/s';
    await startSimulationFromUi('file');
    engineState.update((s) => ({ ...s, session: 'sess-2' }));
    expect(get(simulationState).status).toBe('interrupted');
  });

  it('dismiss clears terminal state; project close resets the flow', async () => {
    tauri.reply('desktop_request', { accepted: true, source_path: '/s', engine_source_dir: CORPUS });
    dialogMock.openImpl = async () => '/s';
    await startSimulationFromUi('file');
    apply('simulation.progress', 2, { stage: 'done', detail: 'ok' });
    expect(get(simulationState).status).toBe('completed');

    dismissSimulationResult();
    expect(get(simulationState).status).toBe('idle');

    projectSnapshot.set(null);
    // Already idle — closing must not resurrect anything.
    expect(get(simulationState).status).toBe('idle');
  });
});
