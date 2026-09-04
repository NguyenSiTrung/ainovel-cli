/**
 * Shell component tests: rendering states for the application frame,
 * navigation, header status/usage/notifications, panels, and error
 * presentation driven by structured error codes.
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

import { cleanup, render, screen } from '@testing-library/svelte';

import { tick } from 'svelte';
import { get } from 'svelte/store';

import ActivityPanel from '$lib/components/ActivityPanel.svelte';
import AppShell from '$lib/components/AppShell.svelte';
import EngineErrorBanner from '$lib/components/EngineErrorBanner.svelte';
import ErrorBanner from '$lib/components/ErrorBanner.svelte';
import HeaderBar from '$lib/components/HeaderBar.svelte';
import NotificationToasts from '$lib/components/NotificationToasts.svelte';
import StreamPanel from '$lib/components/StreamPanel.svelte';
import { ROUTES, currentRoute, navigate } from '$lib/routes';
import {
  activity,
  connectionState,
  dismissNotification,
  disposeDesktop,
  engineState,
  notifications,
  notificationPrefs,
  pushNotification,
  recoveryPrompt,
  runState,
  setNotificationPref,
  stream,
  usage,
} from '$lib/stores/desktop';
import { tauri } from '$tests/tauri-mock';

beforeEach(async () => {
  tauri.reset();
  await disposeDesktop();
  cleanup();
  currentRoute.set('overview');
});

describe('AppShell', () => {
  it('renders header, navigation, workspace, and panels', () => {
    render(AppShell);
    expect(screen.getByTestId('header-bar')).toBeTruthy();
    expect(screen.getByTestId('side-nav')).toBeTruthy();
    expect(screen.getByTestId('workspace')).toBeTruthy();
    expect(screen.getByTestId('side-panels')).toBeTruthy();
    expect(screen.getByTestId('activity-panel')).toBeTruthy();
    expect(screen.getByTestId('stream-panel')).toBeTruthy();
    expect(screen.getByTestId('notification-toasts')).toBeTruthy();
  });

  it('navigation covers all ten task 5-8 routes and switches the workspace', async () => {
    render(AppShell);
    for (const route of ROUTES) {
      const link = screen.getByTestId(`nav-${route.id}`);
      expect(link.textContent?.trim()).toBe(route.label);
    }
    // Task 5 replaced the overview/write placeholders with real screens.
    expect(screen.getByTestId('overview-screen')).toBeTruthy();

    navigate('write');
    await tick();
    expect(screen.getByTestId('write-screen')).toBeTruthy();
    expect(get(currentRoute)).toBe('write');
  });

  it('task 6-8 screens render their real components', async () => {
    render(AppShell);
    navigate('chapters');
    await tick();
    expect(screen.getByTestId('chapters-screen')).toBeTruthy();
    navigate('artifacts');
    await tick();
    expect(screen.getByTestId('artifacts-screen')).toBeTruthy();
    navigate('export');
    await tick();
    expect(screen.getByTestId('export-screen')).toBeTruthy();
    navigate('cocreate');
    await tick();
    expect(screen.getByTestId('cocreate-screen')).toBeTruthy();
    navigate('import');
    await tick();
    expect(screen.getByTestId('import-screen')).toBeTruthy();
    navigate('simulation');
    await tick();
    expect(screen.getByTestId('simulation-screen')).toBeTruthy();
    navigate('settings');
    await tick();
    expect(screen.getByTestId('settings-screen')).toBeTruthy();
  });

  it('recovery banner mounts above the workspace screen when a prompt is set', async () => {
    recoveryPrompt.set({
      at: Date.now(),
      previousSession: 'sess-1',
      currentSession: 'sess-2',
      runStatusBefore: 'running',
      projectWasOpen: true,
    });
    render(AppShell);
    expect(screen.getByTestId('recovery-card')).toBeTruthy();

    recoveryPrompt.set(null);
    await tick();
    expect(screen.queryByTestId('recovery-card')).toBeNull();
  });

  it('switching routes renders the corresponding task 5-8 screen', async () => {
    render(AppShell);
    navigate('diagnostics');
    await tick();
    expect(screen.getByTestId('diagnostics-screen')).toBeTruthy();
    // Screens render the route description verbatim alongside the owner tag.
    expect(
      screen.getByText('Findings, runtime errors, sessions, checkpoints, event queue, sanitized export.', {
        exact: false,
      }),
    ).toBeTruthy();
    navigate('settings');
    await tick();
    expect(screen.getByTestId('settings-screen')).toBeTruthy();
    expect(
      screen.getByText('Providers, models, thinking, languages, budgets, notifications, updates.', {
        exact: false,
      }),
    ).toBeTruthy();
  });
});

describe('HeaderBar', () => {
  it('shows connection state, run status, usage, and notification count', () => {
    connectionState.set('ready');
    engineState.set({
      health: 'ready',
      session: 'sess-abcd1234',
      stopping: false,
      restartAttempts: 0,
      restartsTotal: 0,
      malformedOutputLines: 0,
    });
    runState.set({
      status: 'running',
      step: 'drafting',
      progress: { completed: 2, total: 5, at: 0 },
    });
    usage.set({ totals: { costUsd: 3.5, budgetLimitUsd: 10 } });
    pushNotification('error', 'something broke', { code: 'operation_failed' });

    render(HeaderBar);
    expect(screen.getByTestId('connection-status').textContent).toContain('Connected');
    expect(screen.getByTestId('connection-status').textContent).toContain('(sess-abc)');
    expect(screen.getByTestId('run-status').textContent).toContain('running');
    expect(screen.getByTestId('run-status').textContent).toContain('drafting');
    expect(screen.getByTestId('run-status').textContent).toContain('2/5');
    expect(screen.getByTestId('usage-summary').textContent).toContain('3.50 USD / 10.00');
    expect(screen.getByTestId('notification-count').textContent).toContain('1');
  });

  it('hides run and usage chips when idle', () => {
    connectionState.set('booting');
    render(HeaderBar);
    expect(screen.queryByTestId('run-status')).toBeNull();
    expect(screen.queryByTestId('usage-summary')).toBeNull();
  });

  it('failed engine state is visible', () => {
    connectionState.set('failed');
    render(HeaderBar);
    expect(screen.getByTestId('connection-status').textContent).toContain('Engine failed');
    expect(screen.getByTestId('engine-start')).toBeTruthy();
  });
});

describe('ActivityPanel', () => {
  it('renders newest entries first with sequence numbers', () => {
    const now = Date.now();
    activity.set([
      { id: 1, sequence: 3, event: 'run.started', at: now, summary: 'goal' },
      { id: 2, sequence: 4, event: 'run.progress', at: now, summary: '1/2' },
    ]);
    render(ActivityPanel);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('run.progress');
    expect(items[1]!.textContent).toContain('run.started');
  });

  it('shows an empty state', () => {
    render(ActivityPanel);
    expect(screen.getByText('No engine events yet.')).toBeTruthy();
  });
});

describe('StreamPanel', () => {
  it('shows the current channel text and clear boundaries in history', () => {
    const now = Date.now();
    stream.set({
      entries: [
        { kind: 'text', channel: 'default', text: 'Hello ', sequence: 1, at: now },
        { kind: 'text', channel: 'default', text: 'world', sequence: 2, at: now },
        { kind: 'clear', channel: 'default', reason: 'rerun', sequence: 3, at: now },
        { kind: 'text', channel: 'default', text: 'fresh', sequence: 4, at: now },
      ],
      channels: { default: { text: 'fresh', revision: 1 } },
      lastSequence: 4,
    });
    render(StreamPanel);
    expect(screen.getByTestId('stream-current').textContent).toContain('fresh');
    expect(screen.getByTestId('stream-clear-marker').textContent).toContain('rerun');
    expect(screen.getByTestId('stream-history').textContent).toContain('Hello world');
  });

  it('marks live streaming while a run is active', () => {
    runState.set({ status: 'running' });
    stream.set({ entries: [], channels: {}, lastSequence: -1 });
    render(StreamPanel);
    expect(screen.getByTestId('stream-live')).toBeTruthy();
  });

  it('empty state', () => {
    stream.set({ entries: [], channels: {}, lastSequence: -1 });
    render(StreamPanel);
    expect(screen.getByText('No active stream.')).toBeTruthy();
  });
});

describe('NotificationToasts', () => {
  it('renders notifications with catalog titles for coded errors and dismisses them', async () => {
    pushNotification('error', 'run died', { code: 'engine_unavailable' });
    pushNotification('warning', 'careful', { code: 'host_busy' });
    render(NotificationToasts);

    expect(screen.getByTestId('toast-error').textContent).toContain('Engine unavailable');
    expect(screen.getByTestId('toast-error').textContent).toContain('run died');
    expect(screen.getByTestId('toast-warning').textContent).toContain('Engine busy');

    const first = get(notifications)[0]!;
    dismissNotification(first.id);
    await vi.waitFor(() => expect(screen.queryByTestId('toast-error')).toBeNull());
  });

  it('muted categories stay out of the toast layer; uncategorized ones always show', async () => {
    pushNotification('info', 'run completed', { category: 'completion' });
    pushNotification('error', 'request failed', {}); // uncategorized: always visible
    render(NotificationToasts);

    // Both visible with default prefs.
    expect(screen.getByText('run completed')).toBeTruthy();
    expect(screen.getByText('request failed')).toBeTruthy();

    setNotificationPref('completion', false);
    await vi.waitFor(() => expect(screen.queryByText('run completed')).toBeNull());
    expect(screen.getByText('request failed')).toBeTruthy(); // still surfaces

    // Re-enabling brings the category back (the record persists).
    setNotificationPref('completion', true);
    await vi.waitFor(() => expect(screen.getByText('run completed')).toBeTruthy());
    expect(get(notificationPrefs)).toEqual({ completion: true, pause: true, warning: true, failure: true });
  });
});

describe('ErrorBanner', () => {
  it('presents a known protocol code with title, code tag, and action', () => {
    render(ErrorBanner, {
      props: {
        error: { code: 'project_unavailable', message: 'no project is open' },
        onDismiss: () => {},
      },
    });
    const banner = screen.getByTestId('error-banner');
    expect(banner.textContent).toContain('No project open');
    expect(banner.textContent).toContain('[project_unavailable]');
    expect(banner.textContent).toContain('no project is open');
    expect(banner.textContent).toContain('Open or create a project first.');
  });

  it('presents shell-extension codes and unknown additive codes', () => {
    const { rerender } = render(ErrorBanner, {
      props: { error: { code: 'request_timeout', message: 'engine silent' } },
    });
    expect(screen.getByTestId('error-banner').textContent).toContain('Request timed out');

    rerender({ error: { code: 'future_code', message: 'from a newer engine' } });
    const banner = screen.getByTestId('error-banner');
    expect(banner.textContent).toContain('Unexpected error');
    expect(banner.textContent).toContain('[future_code]');
  });
});

describe('EngineErrorBanner', () => {
  it('renders when connectionState is failed and displays lastError with retry button', () => {
    connectionState.set('failed');
    engineState.set({
      health: 'failed',
      stopping: false,
      restartAttempts: 3,
      restartsTotal: 3,
      malformedOutputLines: 0,
      lastError: 'engine startup error: engine setup is missing: run the interactive TUI once',
    });
    render(EngineErrorBanner);
    const banner = screen.getByTestId('engine-error-banner');
    expect(banner.textContent).toContain('Novel Engine Unavailable');
    expect(banner.textContent).toContain('engine setup is missing');
    expect(banner.textContent).toContain('First-run setup required');
    expect(screen.getByTestId('engine-retry-btn')).toBeTruthy();
  });

  it('is hidden when connectionState is ready', () => {
    connectionState.set('ready');
    render(EngineErrorBanner);
    expect(screen.queryByTestId('engine-error-banner')).toBeNull();
  });
});
