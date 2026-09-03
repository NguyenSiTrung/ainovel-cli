/**
 * Diagnostics controller tests: observer-only contract (only read/export
 * methods ever leave the UI), snapshot projection, sanitized export through
 * the native save dialog (path string forwarded verbatim; cancelled picker
 * sends nothing; `include` never sent), log replay with the minimum-severity
 * filter, runtime queue projection, and project-unavailable silent resets.
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
  diagnosticsState,
  dismissDiagnosticsExport,
  exportDiagnosticsFromUi,
  refreshAllDiagnostics,
  refreshDiagnostics,
  refreshLogs,
  refreshRuntimeQueue,
  resetDiagnosticsState,
} from '$lib/diagnostics';
import { connectionState, disposeDesktop, projectSnapshot } from '$lib/stores/desktop';
import { dialogMock } from '$tests/dialog-mock';
import { installBridgeMarker, tauri } from '$tests/tauri-mock';
import type { ProjectSnapshot } from '$lib/types/protocol';

const SNAPSHOT: ProjectSnapshot = { state: 'idle', book_title: 'Test Novel', total_chapters: 12 };

const DIAG_SNAPSHOT = {
  stats: { completed_chapters: 3, total_chapters: 12, total_words: 9000, phase: 'drafting' },
  findings: [
    {
      rule: 'pacing-slow',
      category: 'pacing',
      severity: 'medium',
      confidence: 'high',
      title: 'Chapters 2-3 drag',
      evidence: 'beat density below target',
      suggestion: 'tighten transitions',
    },
  ],
  runtime: {
    current_step: 'outline',
    stuck_step: '',
    stuck_count: 0,
    log_errors: 2,
    log_warns: 5,
    stop_guard: '',
    models: [{ agent: 'writer', provider: 'openai', model: 'gpt-x' }],
    load_errors: false,
  },
  planned_actions: 1,
};

const LOGS = {
  records: [
    { sequence: 1, time: '2026-09-03T10:00:00Z', level: 'info', module: 'daemon', message: 'started' },
    { sequence: 2, time: '2026-09-03T10:01:00Z', level: 'warn', module: 'run', message: 'retrying provider' },
    { sequence: 3, time: '2026-09-03T10:02:00Z', level: 'error', module: 'import', message: 'import failed' },
  ],
  count: 3,
  last_sequence: 3,
};

const QUEUE = {
  items: [{ seq: 7, time: '2026-09-03T10:03:00Z', priority: 'high', summary: 'rewrite chapter 2', agent: 'editor' }],
  count: 1,
};

function payloadOf(method: string): Record<string, unknown> | undefined {
  const call = tauri
    .callsOf('desktop_request')
    .find((c) => (c.args as { method?: string })?.method === method);
  return (call?.args as { payload?: Record<string, unknown> })?.payload;
}

/** Payload of the MOST RECENT call for methods issued repeatedly. */
function lastPayloadOf(method: string): Record<string, unknown> | undefined {
  const calls = tauri
    .callsOf('desktop_request')
    .filter((c) => (c.args as { method?: string })?.method === method);
  const call = calls[calls.length - 1];
  return (call?.args as { payload?: Record<string, unknown> })?.payload;
}

function callsOfMethod(method: string): number {
  return tauri
    .callsOf('desktop_request')
    .filter((c) => (c.args as { method?: string })?.method === method).length;
}

/** Every desktop_request method the UI issued, for observer-only assertions. */
function allMethods(): string[] {
  return tauri.callsOf('desktop_request').map((c) => (c.args as { method?: string })?.method ?? '?');
}

function scriptEngine(overrides: Record<string, (payload: Record<string, unknown>) => unknown> = {}): void {
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    const payload = (args as { payload?: Record<string, unknown> })?.payload ?? {};
    const handler = overrides[method ?? ''];
    if (handler) return handler(payload);
    switch (method) {
      case 'diagnostics.snapshot':
        return { ...DIAG_SNAPSHOT };
      case 'diagnostics.export':
        return { output_path: '/x/diagnostics-bundle.json', sanitized: true, findings: 1 };
      case 'logs.replay':
        return { ...LOGS };
      case 'runtime.queue':
        return { ...QUEUE };
      default:
        throw { code: 'unknown_method', message: `unexpected ${method}` };
    }
  });
}

beforeEach(async () => {
  tauri.reset();
  dialogMock.reset();
  resetDiagnosticsState();
  await disposeDesktop();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
});

describe('diagnostics snapshot', () => {
  it('projects stats, findings, runtime view, and planned actions', async () => {
    scriptEngine();
    const ok = await refreshDiagnostics();
    expect(ok).toBe(true);
    const state = get(diagnosticsState);
    expect(state.status).toBe('ready');
    expect(state.snapshot?.findings).toHaveLength(1);
    expect(state.snapshot?.findings?.[0]).toMatchObject({ severity: 'medium', title: 'Chapters 2-3 drag' });
    expect(state.snapshot?.runtime).toMatchObject({ log_errors: 2, log_warns: 5 });
    expect(state.snapshot?.planned_actions).toBe(1);
  });

  it('issues only read/export methods (observer-only)', async () => {
    scriptEngine();
    await refreshAllDiagnostics();
    const methods = new Set(allMethods());
    expect([...methods].sort()).toEqual(
      ['diagnostics.snapshot', 'logs.replay', 'runtime.queue'].sort(),
    );
  });

  it('structured failures surface; project_unavailable resets silently', async () => {
    scriptEngine({
      'diagnostics.snapshot': () => {
        throw { code: 'operation_failed', message: 'store unreadable' };
      },
    });
    await refreshDiagnostics();
    expect(get(diagnosticsState).error).toMatchObject({ code: 'operation_failed' });

    tauri.reset();
    scriptEngine({
      'diagnostics.snapshot': () => {
        throw { code: 'project_unavailable', message: 'no project is open' };
      },
    });
    await refreshDiagnostics();
    expect(get(diagnosticsState).error).toBeNull();
    expect(get(diagnosticsState).snapshot).toBeNull();
  });

  it('project close drops the projections', async () => {
    scriptEngine();
    await refreshDiagnostics();
    expect(get(diagnosticsState).snapshot).not.toBeNull();
    projectSnapshot.set(null);
    expect(get(diagnosticsState).snapshot).toBeNull();
  });
});

describe('sanitized export', () => {
  it('native save destination forwarded verbatim; include never sent', async () => {
    scriptEngine();
    dialogMock.saveImpl = async () => '/Users/demo/Downloads/bundle.json';
    const ok = await exportDiagnosticsFromUi();
    expect(ok).toBe(true);
    expect(payloadOf('diagnostics.export')).toEqual({ output_path: '/Users/demo/Downloads/bundle.json' });
    expect(callsOfMethod('diagnostics.export')).toBe(1);
    expect(get(diagnosticsState).exportFlow.result).toMatchObject({
      path: '/x/diagnostics-bundle.json',
      sanitized: true,
      findings: 1,
    });
  });

  it('cancelled picker sends nothing and is not an error', async () => {
    scriptEngine();
    dialogMock.saveImpl = async () => null;
    const ok = await exportDiagnosticsFromUi();
    expect(ok).toBe(false);
    expect(callsOfMethod('diagnostics.export')).toBe(0);
    expect(get(diagnosticsState).exportFlow.error).toBeNull();
    expect(get(diagnosticsState).exportFlow.result).toBeNull();
  });

  it('export failure surfaces the structured error; dismiss clears it', async () => {
    scriptEngine({
      'diagnostics.export': () => {
        throw { code: 'operation_failed', message: 'copy failed' };
      },
    });
    dialogMock.saveImpl = async () => '/x/bundle.json';
    await exportDiagnosticsFromUi();
    expect(get(diagnosticsState).exportFlow.error).toMatchObject({ code: 'operation_failed' });
    dismissDiagnosticsExport();
    expect(get(diagnosticsState).exportFlow.error).toBeNull();
  });

  it('no second export while one is in flight', async () => {
    let release: (value: unknown) => void = () => {};
    scriptEngine({
      'diagnostics.export': () =>
        new Promise((resolve) => {
          release = resolve as (value: unknown) => void;
        }),
    });
    dialogMock.saveImpl = async () => '/x/bundle.json';
    const first = exportDiagnosticsFromUi();
    // Wait until the request is actually in flight before competing.
    await vi.waitFor(() => expect(get(diagnosticsState).exportFlow.status).toBe('exporting'));
    const second = await exportDiagnosticsFromUi();
    expect(second).toBe(false);
    release({ sanitized: true });
    expect(await first).toBe(true);
    expect(callsOfMethod('diagnostics.export')).toBe(1);
  });
});

describe('log replay', () => {
  it('projects records with the count and ring cursor', async () => {
    scriptEngine();
    await refreshLogs();
    const logs = get(diagnosticsState).logs;
    expect(logs.status).toBe('ready');
    expect(logs.records).toHaveLength(3);
    expect(logs.count).toBe(3);
    expect(logs.lastSequence).toBe(3);
  });

  it('default pull replays the whole ring (after_sequence 0); level filter forwarded', async () => {
    scriptEngine();
    await refreshLogs();
    expect(payloadOf('logs.replay')).toEqual({ after_sequence: 0 });
    await refreshLogs('warn');
    expect(lastPayloadOf('logs.replay')).toEqual({ after_sequence: 0, level: 'warn' });
    expect(get(diagnosticsState).logs.level).toBe('warn');
  });

  it('all-records refresh sends no level field', async () => {
    scriptEngine();
    await refreshLogs('error');
    await refreshLogs('');
    expect(lastPayloadOf('logs.replay')).toEqual({ after_sequence: 0 });
  });
});

describe('runtime queue', () => {
  it('projects the persisted queue items', async () => {
    scriptEngine();
    await refreshRuntimeQueue();
    const queue = get(diagnosticsState).queue;
    expect(queue.status).toBe('ready');
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({ seq: 7, priority: 'high', agent: 'editor' });
    expect(payloadOf('runtime.queue')).toEqual({});
  });
});
