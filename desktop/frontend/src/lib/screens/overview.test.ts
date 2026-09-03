/**
 * Overview screen interaction tests: the "no project open" empty state,
 * project lifecycle through native pickers (create with name, open with
 * validation, close), loading states, and the overview projection
 * (identity, progress, runtime, recovery hint, budget, usage, activity,
 * errors). Driven through the scripted Tauri + dialog mocks.
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
import { tick } from 'svelte';

import OverviewScreen from '$lib/screens/OverviewScreen.svelte';
import {
  activity,
  connectionState,
  disposeDesktop,
  notifications,
  projectSnapshot,
  pushNotification,
  runState,
  usage,
} from '$lib/stores/desktop';
import { dialogMock } from '$tests/dialog-mock';
import { installBridgeMarker, tauri } from '$tests/tauri-mock';

const SNAPSHOT = {
  state: 'paused',
  status_label: 'Paused — chapter 5',
  phase: 'drafting',
  flow: 'standard',
  book_title: 'The Lantern Sea',
  synopsis: 'A lighthouse keeper discovers the light answers back.',
  provider: 'openai',
  model: 'gpt-test',
  current_chapter: 5,
  in_progress_chapter: 5,
  total_chapters: 12,
  completed_chapters: 4,
  total_word_count: 42310,
  pending_rewrites: 2,
  total_input_tokens: 120000,
  total_output_tokens: 80000,
  total_cost_usd: 4.2,
  budget_limit_usd: 10,
  advance_mode: 'review',
  recovery_label: 'Interrupted run detected — resume available',
};

function scriptEngine(withSnapshot = true): void {
  tauri.reply('desktop_paths', {
    appDataDir: '/Users/demo/Library/Application Support/ainovel-desktop',
    projectsDir: '/Users/demo/Novels',
    sidecarPath: null,
    sidecarSource: null,
    targetTriple: 'aarch64-apple-darwin',
  });
  tauri.reply('desktop_validate_project_dir', (_cmd: string, args: Record<string, unknown>) => ({
    path: args.path,
    recognized: true,
  }));
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    if (method === 'project.open' || method === 'project.create') return { opened: true };
    if (method === 'project.snapshot') return withSnapshot ? { ...SNAPSHOT } : { state: 'none' };
    if (method === 'project.replay_events') return { replayed: 0, last_sequence: 0 };
    if (method === 'usage.snapshot') return { usage: { runs: 3 } };
    if (method === 'project.close') return { closed: true };
    throw { code: 'unknown_method', message: `unexpected ${method}` };
  });
}

function requestCalls(method: string): Array<Record<string, unknown> | undefined> {
  return tauri
    .callsOf('desktop_request')
    .filter((call) => (call.args as { method?: string })?.method === method)
    .map((call) => call.args?.payload as Record<string, unknown> | undefined);
}

function renderOverview(): ReturnType<typeof render> {
  return render(OverviewScreen, {
    props: { title: 'Overview', description: 'Project overview', owner: 'task 5' },
  });
}

beforeEach(async () => {
  tauri.reset();
  dialogMock.reset();
  await disposeDesktop();
  cleanup();
  installBridgeMarker();
});

describe('overview — no project open empty state', () => {
  it('shows the empty state with lifecycle actions and no projection cards', () => {
    renderOverview();
    expect(screen.getByTestId('overview-empty')).toBeTruthy();
    expect(screen.getByTestId('project-actions')).toBeTruthy();
    expect(screen.queryByTestId('overview-identity')).toBeNull();
    expect(screen.queryByTestId('run-controls')).toBeNull();
  });

  it('shows the last snapshot error hint when the engine could not answer', () => {
    renderOverview();
    expect(screen.queryByTestId('overview-snapshot-error')).toBeNull();
  });
});

describe('overview — project lifecycle through native pickers', () => {
  it('create: name + parent directory picker -> project.create {path, name} -> snapshot loads', async () => {
    scriptEngine();
    renderOverview();
    dialogMock.openImpl = async (options) => {
      expect(options.directory).toBe(true);
      return '/Users/demo/Novels';
    };

    await fireEvent.click(screen.getByTestId('project-action-new'));
    expect(screen.getByTestId('new-project-form')).toBeTruthy();

    const name = screen.getByTestId('project-name-input');
    await fireEvent.input(name, { target: { value: 'My Novel' } });
    await fireEvent.click(screen.getByTestId('project-parent-pick'));
    await vi.waitFor(() => expect(screen.getByTestId('project-parent-path').textContent).toBe('/Users/demo/Novels'));

    await fireEvent.click(screen.getByTestId('project-create-confirm'));
    await vi.waitFor(() => {
      expect(requestCalls('project.create')).toEqual([
        { path: '/Users/demo/Novels/My Novel', name: 'My Novel' },
      ]);
    });
    // The engine snapshot replaces the empty state.
    await vi.waitFor(() => expect(get(projectSnapshot)?.book_title).toBe('The Lantern Sea'));
    await vi.waitFor(() => expect(screen.getByTestId('overview-identity')).toBeTruthy());
  });

  it('create stays disabled until both name and folder are provided', async () => {
    scriptEngine();
    renderOverview();
    await fireEvent.click(screen.getByTestId('project-action-new'));
    const confirm = () => screen.getByTestId('project-create-confirm') as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);

    await fireEvent.input(screen.getByTestId('project-name-input'), { target: { value: 'X' } });
    expect(confirm().disabled).toBe(true);

    dialogMock.openImpl = async () => '/tmp/parent';
    await fireEvent.click(screen.getByTestId('project-parent-pick'));
    await vi.waitFor(() => expect(screen.getByTestId('project-parent-path')).toBeTruthy());
    expect(confirm().disabled).toBe(false);
  });

  it('open: picker path is validated then opened; busy state during open', async () => {
    scriptEngine();
    renderOverview();
    dialogMock.openImpl = async () => '/Users/demo/Novels/Lantern-Sea';

    let releaseOpen: ((value: unknown) => void) | undefined;
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'project.open') {
        return new Promise((resolve) => {
          releaseOpen = resolve;
        });
      }
      if (method === 'project.snapshot') return { ...SNAPSHOT };
      if (method === 'project.replay_events') return { replayed: 0 };
      if (method === 'usage.snapshot') return {};
      throw { code: 'unknown_method', message: 'x' };
    });

    await fireEvent.click(screen.getByTestId('project-action-open'));
    await vi.waitFor(() => expect(screen.getByTestId('project-action-open').textContent).toBe('Opening…'));
    expect(tauri.callsOf('desktop_validate_project_dir')).toHaveLength(1);
    expect((tauri.callsOf('desktop_validate_project_dir')[0]!.args as { path?: string }).path).toBe(
      '/Users/demo/Novels/Lantern-Sea',
    );

    releaseOpen!({ opened: true });
    await vi.waitFor(() => {
      expect(requestCalls('project.open')).toEqual([{ path: '/Users/demo/Novels/Lantern-Sea' }]);
      expect(screen.getByTestId('project-action-open').textContent).toBe('Open…');
    });
    await vi.waitFor(() => expect(screen.getByTestId('overview-identity')).toBeTruthy());
  });

  it('open with unrecognized marker warns but still asks the engine', async () => {
    scriptEngine();
    tauri.reply('desktop_validate_project_dir', (_cmd: string, args: Record<string, unknown>) => ({
      path: args.path,
      recognized: false,
    }));
    renderOverview();
    dialogMock.openImpl = async () => '/Users/demo/Novels/Empty-Folder';

    await fireEvent.click(screen.getByTestId('project-action-open'));
    await vi.waitFor(() => expect(requestCalls('project.open')).toEqual([{ path: '/Users/demo/Novels/Empty-Folder' }]));
    await vi.waitFor(() => expect(screen.getByTestId('project-open-unrecognized')).toBeTruthy());
    expect(get(notifications).some((n) => n.level === 'warning' && n.message.includes('no project marker'))).toBe(true);
  });

  it('cancelled picker issues no engine commands and keeps the idle label', async () => {
    scriptEngine();
    renderOverview();
    dialogMock.openImpl = async () => null; // user cancelled

    await fireEvent.click(screen.getByTestId('project-action-open'));
    await tick();
    expect(tauri.callsOf('desktop_validate_project_dir')).toHaveLength(0);
    expect(requestCalls('project.open')).toEqual([]);
    expect(screen.getByTestId('project-action-open').textContent).toBe('Open…');
  });

  it('create failure surfaces the structured error and keeps the form', async () => {
    scriptEngine();
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'project.create') {
        throw { code: 'operation_failed', message: 'directory already contains a project' };
      }
      if (method === 'project.snapshot') return { state: 'none' };
      return {};
    });
    renderOverview();
    dialogMock.openImpl = async () => '/Users/demo/Novels';
    await fireEvent.click(screen.getByTestId('project-action-new'));
    await fireEvent.input(screen.getByTestId('project-name-input'), { target: { value: 'Dup' } });
    await fireEvent.click(screen.getByTestId('project-parent-pick'));
    await vi.waitFor(() => expect(screen.getByTestId('project-parent-path')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('project-create-confirm'));

    await vi.waitFor(() =>
      expect(get(notifications).some((n) => n.code === 'operation_failed' && n.message.includes('directory already contains a project'))).toBe(true),
    );
    expect(screen.getByTestId('new-project-form')).toBeTruthy();
    expect(get(projectSnapshot)).toBeNull();
  });

  it('close: engine project.close clears the projection back to the empty state', async () => {
    scriptEngine();
    projectSnapshot.set({ ...SNAPSHOT });
    connectionState.set('ready');
    renderOverview();
    await vi.waitFor(() => expect(screen.getByTestId('overview-identity')).toBeTruthy());

    await fireEvent.click(screen.getByTestId('project-action-close'));
    await vi.waitFor(() => expect(requestCalls('project.close')).toEqual([{}]));
    await vi.waitFor(() => expect(get(projectSnapshot)).toBeNull());
    await vi.waitFor(() => expect(screen.getByTestId('overview-empty')).toBeTruthy());
  });
});

describe('overview — projection of backend state', () => {
  beforeEach(() => {
    connectionState.set('ready');
  });

  it('renders identity, progress, runtime, recovery, budget, usage, activity, errors', async () => {
    projectSnapshot.set({ ...SNAPSHOT });
    runState.set({ status: 'paused', step: 'drafting', pause: { reason: 'advance gate', advanceHold: true, at: 0 } });
    usage.set({ totals: { inputTokens: 120000, outputTokens: 80000, costUsd: 4.2, budgetLimitUsd: 10 }, updatedAt: 0 });
    activity.set([
      { id: 1, sequence: 3, event: 'run.started', at: 0, summary: 'chapter 5' },
      { id: 2, sequence: 4, event: 'chapter.updated', at: 0, summary: 'saved' },
    ]);
    pushNotification('error', 'provider hiccup', { code: 'operation_failed' });

    renderOverview();

    expect(screen.getByTestId('overview-identity').textContent).toContain('The Lantern Sea');
    expect(screen.getByTestId('overview-identity').textContent).toContain('Paused — chapter 5');
    expect(screen.getByTestId('overview-synopsis').textContent).toContain('lighthouse keeper');

    expect(screen.getByTestId('overview-chapters').textContent).toBe('4/12');
    expect(screen.getByTestId('overview-words').textContent).toBe('42,310');

    expect(screen.getByTestId('overview-runtime').textContent).toContain('ready');
    expect(screen.getByTestId('overview-run-status').textContent).toContain('paused');

    expect(screen.getByTestId('overview-recovery-label').textContent).toContain('Interrupted run detected');

    expect(screen.getByTestId('overview-budget-amount').textContent).toBe('$4.20 of $10.00');
    expect(screen.getByTestId('overview-usage').textContent).toContain('120,000');

    expect(screen.getByTestId('overview-activity').textContent).toContain('chapter.updated');
    expect(screen.getByTestId('overview-error-item').textContent).toContain('provider hiccup');
  });

  it('shows the completed terminal state and clear recovery when healthy', async () => {
    projectSnapshot.set({ ...SNAPSHOT, recovery_label: undefined, state: 'idle' });
    runState.set({ status: 'completed', terminal: { kind: 'run.completed', at: 0, summary: { chapters: 4 } } });
    renderOverview();

    expect(screen.getByTestId('overview-run-terminal').textContent).toContain('run completed');
    expect(screen.getByTestId('overview-recovery-clear')).toBeTruthy();
    expect(screen.getByTestId('overview-no-errors')).toBeTruthy();
  });

  it('run controls are present and gated by engine state', async () => {
    projectSnapshot.set({ ...SNAPSHOT });
    runState.set({ status: 'idle' });
    renderOverview();

    // Start needs a goal; with one typed it is enabled.
    const start = () => screen.getByTestId('run-control-start') as HTMLButtonElement;
    await fireEvent.input(screen.getByTestId('run-goal-input'), { target: { value: 'chapter 5' } });
    expect(start().disabled).toBe(false);
    expect(screen.queryByTestId('run-control-pause')).toBeNull();

    runState.set({ status: 'running' });
    await tick();
    expect(screen.queryByTestId('run-control-start')).toBeNull();
    expect((screen.getByTestId('run-control-pause') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('run-steer-input')).toBeTruthy();
  });
});
