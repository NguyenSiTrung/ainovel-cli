/**
 * Import controller tests: native source picker (cancelled picker sends
 * nothing), import.start payload with the picked path + engine-documented
 * options, progress projection, structural terminal signals (stage:"done"
 * with continued; payload error), cancel semantics (cancelled:true/false),
 * resume, structured request failures, and the terminal snapshot resync —
 * all against the scripted mock bridge.
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
  cancelImportFromUi,
  deriveImportControls,
  dismissImportResult,
  importState,
  resetImportState,
  resumeImportFromUi,
  startImportFromUi,
} from '$lib/imports';
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

function payloadOf(method: string): Record<string, unknown> | undefined {
  const call = tauri
    .callsOf('desktop_request')
    .find((c) => (c.args as { method?: string })?.method === method);
  return (call?.args as { payload?: Record<string, unknown> })?.payload;
}

function methodCallCount(method: string): number {
  return tauri
    .callsOf('desktop_request')
    .filter((c) => (c.args as { method?: string })?.method === method).length;
}

function apply(event: string, sequence: number, payload: Record<string, unknown> = {}): void {
  applyEngineEvent(engineEvent(event, sequence, payload, 'sess-1') as unknown as EventEnvelope);
}

const DEFAULT_OPTIONS = { auto_confirm: true, continue_after: false };

function scriptEngine(importHandler: (payload: Record<string, unknown>) => unknown = () => ({
  accepted: true,
  source_path: '/books/source.txt',
})): void {
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    const payload = (args as { payload?: Record<string, unknown> })?.payload ?? {};
    switch (method) {
      case 'project.snapshot':
        return { ...SNAPSHOT };
      case 'import.start':
        return importHandler(payload);
      default:
        return { accepted: true, echo: payload };
    }
  });
}

beforeEach(async () => {
  tauri.reset();
  dialogMock.reset();
  resetImportState();
  await disposeDesktop();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
  engineState.set({ health: 'ready', stopping: false, restartAttempts: 0, restartsTotal: 0, malformedOutputLines: 0, session: 'sess-1' });
});

describe('import.start via the native picker', () => {
  it('picks a file (no filesystem access) and forwards the path verbatim with options', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/the-lantern-sea.txt';
    const ok = await startImportFromUi(DEFAULT_OPTIONS);
    expect(ok).toBe(true);

    // The picker was a single-file open; the frontend only saw a string.
    expect(dialogMock.openCalls[0]?.directory).toBe(false);
    expect(dialogMock.openCalls[0]?.multiple).toBe(false);
    expect(payloadOf('import.start')).toEqual({
      source_path: '/books/the-lantern-sea.txt',
      options: DEFAULT_OPTIONS,
    });

    const s = get(importState);
    expect(s.status).toBe('running');
    // The engine's echoed source path is authoritative.
    expect(s.sourcePath).toBe('/books/source.txt');
  });

  it('a cancelled picker sends nothing and is not an error', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => null;
    const ok = await startImportFromUi(DEFAULT_OPTIONS);
    expect(ok).toBe(false);
    expect(tauri.callsOf('desktop_request')).toHaveLength(0);
    expect(get(importState).status).toBe('idle');
    expect(get(importState).error).toBeNull();
  });

  it('an inaccessible source fails with the structured engine error', async () => {
    scriptEngine(() => {
      throw { code: 'operation_failed', message: 'source file not accessible: open /x: no such file' };
    });
    dialogMock.openImpl = async () => '/x/missing.txt';
    const ok = await startImportFromUi(DEFAULT_OPTIONS);
    expect(ok).toBe(false);
    const s = get(importState);
    expect(s.status).toBe('idle');
    expect(s.error?.code).toBe('operation_failed');
    expect(s.error?.message).toContain('source file not accessible');
  });
});

describe('import.progress projection (structural signals only)', () => {
  async function running(): Promise<void> {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/source.txt';
    await startImportFromUi(DEFAULT_OPTIONS);
  }

  it('progress facts update the live projection and the bounded recent list', async () => {
    await running();
    apply('import.progress', 2, { stage: 'ingesting', completed: 2, total: 10, detail: 'reading' });
    apply('import.progress', 3, { stage: 'segmenting', completed: 5, total: 10, detail: 'splitting' });

    const s = get(importState);
    expect(s.status).toBe('running');
    expect(s.progress).toMatchObject({ stage: 'segmenting', completed: 5, total: 10, detail: 'splitting' });
    expect(s.recent).toHaveLength(2);
  });

  it('stage:"done" completes (recording continued) and re-reads the authoritative snapshot', async () => {
    await running();
    const snapshotsBefore = methodCallCount('project.snapshot');
    apply('import.progress', 2, { stage: 'done', completed: 10, total: 10, detail: 'published', continued: true });

    const s = get(importState);
    expect(s.status).toBe('completed');
    expect(s.result).toMatchObject({ continued: true, detail: 'published' });
    // Foundation/chapters published engine-side -> snapshot refetch.
    expect(methodCallCount('project.snapshot')).toBeGreaterThan(snapshotsBefore);
  });

  it('a payload error fact fails the run with operation_failed', async () => {
    await running();
    apply('import.progress', 2, { stage: 'analyzing', completed: 3, total: 9, detail: 'boom', error: 'provider exploded' });

    const s = get(importState);
    expect(s.status).toBe('failed');
    expect(s.error?.code).toBe('operation_failed');
    expect(s.error?.message).toBe('provider exploded');
  });

  it('facts outside an accepted run are ignored (no invented state)', async () => {
    apply('import.progress', 2, { stage: 'done', detail: 'stale replay' });
    expect(get(importState).status).toBe('idle');
  });
});

describe('import.resume / import.cancel', () => {
  it('resume re-enters the engine workspace with no payload', async () => {
    scriptEngine();
    const ok = await resumeImportFromUi();
    expect(ok).toBe(true);
    expect(payloadOf('import.resume')).toEqual({});
    expect(get(importState).status).toBe('running');
  });

  it('resume failure (engine busy) surfaces the structured error', async () => {
    scriptEngine(() => {
      throw { code: 'host_busy', message: 'a generation run is already active' };
    });
    // import.resume goes through the default echo handler; script it properly:
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'import.resume') {
        throw { code: 'host_busy', message: 'a generation run is already active' };
      }
      return { accepted: true };
    });
    const ok = await resumeImportFromUi();
    expect(ok).toBe(false);
    expect(get(importState).error?.code).toBe('host_busy');
    expect(get(importState).status).toBe('idle');
  });

  it('cancel answered cancelled:true stops the flow', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/source.txt';
    await startImportFromUi(DEFAULT_OPTIONS);

    tauri.on('desktop_request', () => ({ cancelled: true }));
    const ok = await cancelImportFromUi();
    expect(ok).toBe(true);
    expect(payloadOf('import.cancel')).toEqual({});
    expect(get(importState).status).toBe('cancelled');
  });

  it('cancel answered cancelled:false keeps the status and surfaces the reason', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/source.txt';
    await startImportFromUi(DEFAULT_OPTIONS);
    apply('import.progress', 2, { stage: 'ingesting', detail: 'reading' });

    tauri.on('desktop_request', () => ({ cancelled: false, reason: 'no import in progress' }));
    await cancelImportFromUi();
    const s = get(importState);
    expect(s.status).toBe('running');
    expect(s.message).toBe('no import in progress');
  });

  it('cancel is only offered while a run is accepted', async () => {
    const avail = deriveImportControls(get(importState), SNAPSHOT, 'ready');
    expect(avail.canCancel).toBe(false);
    expect(avail.canStart).toBe(true);
    expect(avail.canResume).toBe(true);
  });
});

describe('terminal handling and resets', () => {
  it('a done event beating the acceptance response does not reopen the flow', async () => {
    let release: (value: unknown) => void = () => {};
    let requestInFlight = false;
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'import.start') {
        requestInFlight = true;
        return new Promise((resolve) => {
          release = resolve as (value: unknown) => void;
        });
      }
      return { accepted: true };
    });
    dialogMock.openImpl = async () => '/books/source.txt';

    const pending = startImportFromUi(DEFAULT_OPTIONS);
    await vi.waitFor(() => expect(requestInFlight).toBe(true));
    // The daemon's drain goroutine emitted done while the response was pending.
    apply('import.progress', 2, { stage: 'done', detail: 'published', continued: false });
    release({ accepted: true, source_path: '/books/source.txt' });
    expect(await pending).toBe(true);

    const s = get(importState);
    expect(s.status).toBe('completed');
    expect(s.result?.detail).toBe('published');
  });

  it('dismiss clears a completed result', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/source.txt';
    await startImportFromUi(DEFAULT_OPTIONS);
    apply('import.progress', 2, { stage: 'done', detail: 'published', continued: false });
    expect(get(importState).status).toBe('completed');

    dismissImportResult();
    expect(get(importState).status).toBe('idle');
    expect(get(importState).result).toBeNull();
  });

  it('facts recorded before a project close are not replayed onto the next import (no disposeDesktop)', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/first.txt';
    await startImportFromUi(DEFAULT_OPTIONS);
    apply('import.progress', 2, { stage: 'done', detail: 'published', continued: true });
    expect(get(importState).status).toBe('completed');

    // Project closes WITHOUT disposeDesktop: the projection resets while the
    // shared fact store keeps its history.
    projectSnapshot.set(null);
    expect(get(importState).status).toBe('idle');

    // New project, new import: when the next fact arrives the subscriber sees
    // the whole array again — the old done fact must not complete this flow
    // (nor fire its snapshot resync).
    projectSnapshot.set({ ...SNAPSHOT });
    dialogMock.openImpl = async () => '/books/second.txt';
    await startImportFromUi(DEFAULT_OPTIONS);
    apply('import.progress', 3, { stage: 'ingesting', detail: 'reading the second file' });

    const s = get(importState);
    expect(s.status).toBe('running');
    expect(s.progress?.detail).toBe('reading the second file');
    expect(s.result).toBeNull();
  });

  it('an engine session change mid-run marks the run interrupted', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/source.txt';
    await startImportFromUi(DEFAULT_OPTIONS);
    engineState.update((s) => ({ ...s, session: 'sess-2' }));
    expect(get(importState).status).toBe('interrupted');
  });

  it('closing the project resets the flow', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/source.txt';
    await startImportFromUi(DEFAULT_OPTIONS);
    projectSnapshot.set(null);
    expect(get(importState).status).toBe('idle');
  });
});
