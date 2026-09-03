/**
 * Diagnostics screen tests: rendering (stats, findings with severity,
 * runtime view, session bookkeeping, queue, logs with severity filter and
 * full-record expansion, usage/budget detail), the sanitized export flow
 * (native destination → one request), the empty state, and the observer-only
 * contract (no repair/resume/mutate affordance exists on this screen).
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

import DiagnosticsScreen from '$lib/screens/DiagnosticsScreen.svelte';
import { resetDiagnosticsState } from '$lib/diagnostics';
import {
  applyEngineEvent,
  connectionState,
  disposeDesktop,
  engineState,
  projectSnapshot,
} from '$lib/stores/desktop';
import { dialogMock } from '$tests/dialog-mock';
import { engineEvent as makeEngineEvent, installBridgeMarker, tauri } from '$tests/tauri-mock';
import type { EventEnvelope } from '$lib/types/protocol';

const SNAPSHOT = { state: 'idle', book_title: 'The Lantern Sea', total_chapters: 12, recovery_label: 'checkpoint 4' };

const DIAG = {
  stats: { completed_chapters: 3, total_chapters: 12, total_words: 9123, phase: 'drafting', flow: 'flow-a', avg_review_score: 7.5, foreshadow_open: 2, foreshadow_stale: 1 },
  findings: [
    {
      rule: 'pacing-slow',
      category: 'pacing',
      severity: 'high',
      confidence: 'high',
      title: 'Middle chapters drag',
      evidence: 'beat density below target in chapters 5-7',
      suggestion: 'tighten the transitions',
    },
    {
      rule: 'dialog-flat',
      category: 'style',
      severity: 'low',
      confidence: 'medium',
      title: 'Dialogue lacks voice',
      evidence: 'repeated phrasing',
      suggestion: 'vary sentence rhythm',
    },
  ],
  runtime: {
    current_step: 'outline',
    stuck_step: 'outline',
    stuck_count: 3,
    log_errors: 2,
    log_warns: 5,
    stop_guard: 'budget-hold',
    models: [
      { agent: 'writer', provider: 'openai', model: 'gpt-4o-mini' },
      { agent: 'editor', provider: 'openai', model: 'gpt-4o' },
    ],
    load_errors: true,
  },
  planned_actions: 2,
};

const LOGS = {
  records: [
    { sequence: 1, time: '2026-09-03T10:00:00Z', level: 'info', module: 'daemon', message: 'started', attrs: { session: 's-1' } },
    { sequence: 2, time: '2026-09-03T10:01:00Z', level: 'warn', module: 'run', message: 'provider retry scheduled' },
    { sequence: 3, time: '2026-09-03T10:02:00Z', level: 'error', module: 'import', message: 'source unreadable' },
  ],
  count: 3,
  last_sequence: 3,
};

const QUEUE = {
  items: [
    { seq: 7, time: '2026-09-03T10:03:00Z', priority: 'high', summary: 'rewrite chapter 2', agent: 'editor', category: 'revision' },
    { seq: 8, time: '2026-09-03T10:04:00Z', priority: 'low', summary: 'recheck facts' },
  ],
  count: 2,
};

function scriptEngine(overrides: Record<string, (payload: Record<string, unknown>) => unknown> = {}): void {
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    const payload = (args as { payload?: Record<string, unknown> })?.payload ?? {};
    const handler = overrides[method ?? ''];
    if (handler) return handler(payload);
    switch (method) {
      case 'diagnostics.snapshot':
        return { ...DIAG };
      case 'diagnostics.export':
        return { output_path: '/x/diagnostics-bundle.json', sanitized: true, findings: 2 };
      case 'logs.replay':
        return { ...LOGS };
      case 'runtime.queue':
        return { ...QUEUE };
      case 'usage.snapshot':
        return {
          usage: { input_tokens: 12000, output_tokens: 3400, cache_read_tokens: 900, cache_write_tokens: 100, cost_usd: 1.25, saved_usd: 0.3 },
          budget: { limit_usd: 25, spent_usd: 1.25 },
          per_agent: [{ role: 'writer', input: 8000, output: 3000, cache_read: 500, cache_write: 100, cost_usd: 1.0, saved_usd: 0.2 }],
        };
      case 'project.snapshot':
        return { ...SNAPSHOT };
      default:
        throw { code: 'unknown_method', message: `unexpected ${method}` };
    }
  });
}

function payloadOf(method: string): Record<string, unknown> | undefined {
  const call = tauri
    .callsOf('desktop_request')
    .find((c) => (c.args as { method?: string })?.method === method);
  return (call?.args as { payload?: Record<string, unknown> })?.payload;
}

/** Payload of the MOST RECENT call (methods issued repeatedly). */
function lastPayloadOf(method: string): Record<string, unknown> | undefined {
  const calls = tauri
    .callsOf('desktop_request')
    .filter((c) => (c.args as { method?: string })?.method === method);
  const call = calls[calls.length - 1];
  return (call?.args as { payload?: Record<string, unknown> })?.payload;
}

function renderDiagnostics(): void {
  render(DiagnosticsScreen, { props: { title: 'Diagnostics', description: 'Diagnostics description', owner: 'task 8' } });
}

beforeEach(async () => {
  tauri.reset();
  dialogMock.reset();
  resetDiagnosticsState();
  await disposeDesktop();
  cleanup();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
  engineState.set({ health: 'ready', stopping: false, restartAttempts: 0, restartsTotal: 0, malformedOutputLines: 0, session: 'sess-diag' });
});

describe('diagnostics screen', () => {
  it('no project open: empty state, no requests', async () => {
    projectSnapshot.set(null);
    renderDiagnostics();
    expect(screen.getByTestId('diagnostics-empty')).toBeTruthy();
    expect(tauri.callsOf('desktop_request')).toHaveLength(0);
  });

  it('renders findings with severity badges and expandable evidence/suggestion', async () => {
    scriptEngine();
    renderDiagnostics();
    await vi.waitFor(() => expect(screen.getAllByTestId('diagnostics-finding').length).toBeGreaterThan(0));
    const findings = screen.getAllByTestId('diagnostics-finding');
    expect(findings).toHaveLength(2);
    expect(findings[0]?.textContent).toContain('Middle chapters drag');
    expect(findings[0]?.textContent).toContain('high');
    expect(findings[0]?.textContent).toContain('beat density below target');
    expect(findings[0]?.textContent).toContain('tighten the transitions');
  });

  it('renders the runtime view: step, stuck counter, log errors, per-agent models', async () => {
    scriptEngine();
    renderDiagnostics();
    await vi.waitFor(() => expect(screen.getByTestId('diagnostics-runtime').textContent).toContain('outline'));
    expect(screen.getByTestId('diagnostics-log-errors').textContent).toBe('2');
    expect(screen.getByTestId('diagnostics-runtime').textContent).toContain('×3');
    expect(screen.getByTestId('diagnostics-models').textContent).toContain('gpt-4o-mini');
    expect(screen.getByTestId('diagnostics-runtime').textContent).toContain('budget-hold');
  });

  it('renders session bookkeeping, the recovery label, and observed checkpoints', async () => {
    scriptEngine();
    applyEngineEvent(
      makeEngineEvent('checkpoint.created', 11, { checkpoint_id: 'cp-42' }, 'sess-diag') as unknown as EventEnvelope,
    );
    renderDiagnostics();
    await vi.waitFor(() => expect(screen.getByTestId('diagnostics-session').textContent).toContain('sess-diag'));
    expect(screen.getByTestId('diagnostics-session').textContent).toContain('checkpoint 4');
    expect(screen.getByTestId('diagnostics-checkpoints').textContent).toContain('cp-42');
  });

  it('renders the runtime queue items', async () => {
    scriptEngine();
    renderDiagnostics();
    await vi.waitFor(() => expect(screen.getByTestId('diagnostics-queue-items').textContent).toContain('rewrite chapter 2'));
    expect(screen.getByTestId('diagnostics-queue').textContent).toContain('2');
  });

  it('renders usage and budget detail including per-agent rows', async () => {
    scriptEngine();
    renderDiagnostics();
    await vi.waitFor(() => expect(screen.getByTestId('diagnostics-usage').textContent).toContain('12,000'));
    expect(screen.getByTestId('diagnostics-usage').textContent).toContain('$1.25');
    expect(screen.getByTestId('diagnostics-usage').textContent).toContain('$25.00');
    expect(screen.getByTestId('diagnostics-usage-per-agent').textContent).toContain('writer');
  });

  it('renders log records and the full record detail on expansion', async () => {
    scriptEngine();
    renderDiagnostics();
    await vi.waitFor(() => expect(screen.getByTestId('diagnostics-logs-records').textContent).toContain('provider retry scheduled'));
    const records = screen.getByTestId('diagnostics-logs-records');
    expect(records.textContent).toContain('daemon');
    // Full-detail payload (attrs) is present in the expanded record body.
    expect(records.textContent).toContain('"session"');
    expect(records.textContent).toContain('s-1');
  });

  it('severity filter change issues a filtered replay and shows the filtered records', async () => {
    scriptEngine();
    renderDiagnostics();
    await vi.waitFor(() => expect(screen.getByTestId('diagnostics-logs-records')).toBeTruthy());
    await fireEvent.change(screen.getByTestId('diagnostics-logs-level'), { target: { value: 'warn' } });
    await vi.waitFor(() =>
      expect(lastPayloadOf('logs.replay')).toEqual({ after_sequence: 0, level: 'warn' }),
    );
  });

  it('export: native destination → one diagnostics.export with the verbatim path', async () => {
    scriptEngine();
    dialogMock.saveImpl = async () => '/Users/demo/Downloads/bundle.json';
    renderDiagnostics();
    await fireEvent.click(screen.getByTestId('diagnostics-export'));
    await vi.waitFor(() => expect(screen.getByTestId('diagnostics-export-result')).toBeTruthy());
    expect(payloadOf('diagnostics.export')).toEqual({ output_path: '/Users/demo/Downloads/bundle.json' });
    expect(screen.getByTestId('diagnostics-export-result').textContent).toContain('/x/diagnostics-bundle.json');
    expect(screen.getByTestId('diagnostics-export-result').textContent).toContain('2 findings');
  });

  it('cancelled export destination sends nothing', async () => {
    scriptEngine();
    dialogMock.saveImpl = async () => null;
    renderDiagnostics();
    await fireEvent.click(screen.getByTestId('diagnostics-export'));
    await vi.waitFor(() => expect(dialogMock.saveCalls).toHaveLength(1));
    expect(tauri.callsOf('desktop_request').filter((c) => (c.args as { method?: string })?.method === 'diagnostics.export')).toHaveLength(0);
    expect(screen.queryByTestId('diagnostics-export-result')).toBeNull();
  });

  it('export failure shows the structured error and can be dismissed', async () => {
    scriptEngine({
      'diagnostics.export': () => {
        throw { code: 'operation_failed', message: 'copy failed: disk full' };
      },
    });
    dialogMock.saveImpl = async () => '/x/bundle.json';
    renderDiagnostics();
    await fireEvent.click(screen.getByTestId('diagnostics-export'));
    await vi.waitFor(() => expect(screen.getByTestId('diagnostics-export-error')).toBeTruthy());
    expect(screen.getByTestId('diagnostics-export-error').textContent).toContain('[operation_failed]');
    await fireEvent.click(screen.getByTestId('diagnostics-export-dismiss-error'));
    await vi.waitFor(() => expect(screen.queryByTestId('diagnostics-export-error')).toBeNull());
  });

  it('observer-only: refresh issues only read/export methods; no repair/resume control exists', async () => {
    scriptEngine();
    renderDiagnostics();
    await vi.waitFor(() => expect(screen.getAllByTestId('diagnostics-finding').length).toBeGreaterThan(0));
    await fireEvent.click(screen.getByTestId('diagnostics-refresh'));
    await vi.waitFor(() =>
      expect(tauri.callsOf('desktop_request').length).toBeGreaterThanOrEqual(8),
    );
    const methods = new Set(
      tauri.callsOf('desktop_request').map((c) => (c.args as { method?: string })?.method),
    );
    expect([...methods].every((m) => ['diagnostics.snapshot', 'diagnostics.export', 'logs.replay', 'runtime.queue', 'usage.snapshot'].includes(m ?? ''))).toBe(true);
    // No mutation affordances on this screen.
    const text = document.body.textContent ?? '';
    for (const banned of ['Resume', 'Repair', 'Abort', 'Pause run', 'Start run']) {
      expect(text).not.toContain(banned);
    }
  });
});
