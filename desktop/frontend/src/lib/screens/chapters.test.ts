/**
 * Chapters screen tests (DOM level through the scripted Tauri bridge):
 * list/status projection, read + markdown render, edit + save flow with
 * base_version, dirty protection on navigation (guard card save/discard/
 * stay), conflict resolution UI (reload / review-then-overwrite), and the
 * revisions panel (check on entry + on demand, sync confirmation, async
 * result, host_busy error).
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
import { tick } from 'svelte';

import AppShell from '$lib/components/AppShell.svelte';
import ChaptersScreen from '$lib/screens/ChaptersScreen.svelte';
import { resetChaptersState } from '$lib/chapters';
import { currentRoute, navigate } from '$lib/routes';
import {
  applyEngineEvent,
  connectionState,
  disposeDesktop,
  projectSnapshot,
} from '$lib/stores/desktop';
import { engineEvent, installBridgeMarker, tauri } from '$tests/tauri-mock';
import type { EventEnvelope } from '$lib/types/protocol';

const SNAPSHOT = {
  state: 'idle',
  book_title: 'The Lantern Sea',
  total_chapters: 12,
  completed_chapters: 3,
  total_word_count: 7900,
};

const LIST = {
  chapters: [
    { chapter: 1, title: 'The Arrival', words: 3200, version: 4, origin: 'engine', status: 'saved' },
    { chapter: 2, title: 'First Light', words: 2800, version: 2, origin: 'user', status: 'saved' },
    { chapter: 3, title: 'The Bargain', words: 1900, version: 1, status: 'saved' },
  ],
  completed: 3,
  total: 12,
  in_progress: 4,
  pending_rewrites: 1,
};

interface Script {
  readContent?: string;
  readVersion?: number;
  saveBehavior?: 'ok' | 'conflict' | 'host_busy';
  checkChapters?: number[];
  syncBehavior?: 'accept' | 'host_busy' | 'noop';
}

/** Per-method overrides that REPLACE the default scripted behavior. */
function scriptEngine(script: Script = {}, overrides: Record<string, (payload: Record<string, unknown>) => unknown> = {}): void {
  const readContent = script.readContent ?? '# Chapter 1\n\nThe harbour lights came on **one by one**.';
  const readVersion = script.readVersion ?? 4;
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    const payload = (args as { payload?: Record<string, unknown> })?.payload ?? {};
    const override = method !== undefined ? overrides[method] : undefined;
    if (override) return override(payload);
    switch (method) {
      case 'chapter.list':
        return LIST;
      case 'chapter.read':
        return { chapter: payload.chapter, content: readContent, words: 42, version: readVersion, origin: 'engine' };
      case 'chapter.save': {
        if (script.saveBehavior === 'host_busy') {
          throw { code: 'host_busy', message: 'a generation run is already active' };
        }
        if (script.saveBehavior === 'conflict') {
          throw {
            code: 'operation_failed',
            message: `chapter ${payload.chapter} was modified concurrently (base_version=${payload.base_version}, current version=6)`,
            details: { conflict: true, current_version: 6 },
          };
        }
        return { chapter: payload.chapter, version: (payload.base_version as number ?? 0) + 1, saved: true };
      }
      case 'chapter.revisions.check':
        return { chapters: script.checkChapters ?? [], count: (script.checkChapters ?? []).length };
      case 'chapter.revisions.sync': {
        if (script.syncBehavior === 'host_busy') {
          throw { code: 'host_busy', message: 'a generation run is already active' };
        }
        if (script.syncBehavior === 'noop') {
          return { changed: [], applied: [] };
        }
        return { accepted: true, changed: script.checkChapters ?? [] };
      }
      case 'project.snapshot':
        return { ...SNAPSHOT };
      case 'project.replay_events':
        return { replayed: 0, last_sequence: 0 };
      case 'usage.snapshot':
        return { usage: {} };
      default:
        throw { code: 'unknown_method', message: `unexpected ${method}` };
    }
  });
}

function payloadOf(method: string, index = -1): Record<string, unknown> {
  const calls = tauri.callsOf('desktop_request').filter((c) => (c.args as { method?: string })?.method === method);
  const call = index < 0 ? calls[calls.length - 1] : calls[index];
  return (call?.args as { payload?: Record<string, unknown> })?.payload ?? {};
}

function countOf(method: string): number {
  return tauri.callsOf('desktop_request').filter((c) => (c.args as { method?: string })?.method === method).length;
}

function renderChapters(): void {
  render(ChaptersScreen, { props: { title: 'Chapters', description: 'Chapter tools', owner: 'task 6' } });
}

function apply(event: string, sequence: number, payload: Record<string, unknown> = {}): void {
  applyEngineEvent(engineEvent(event, sequence, payload, 'sess-1') as unknown as EventEnvelope);
}

/** Wait for the list projection, open chapter 1, wait for the reader. */
async function openFirstChapter(): Promise<void> {
  await vi.waitFor(() => expect(screen.getByTestId('chapter-row-1')).toBeTruthy());
  await fireEvent.click(screen.getByTestId('chapter-row-1'));
  await vi.waitFor(() => expect(screen.getByTestId('chapter-content')).toBeTruthy());
}

beforeEach(async () => {
  tauri.reset();
  await disposeDesktop();
  resetChaptersState();
  cleanup();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
  currentRoute.set('chapters');
});

describe('chapters screen — list + read', () => {
  it('no project open: empty state', () => {
    projectSnapshot.set(null);
    renderChapters();
    expect(screen.getByTestId('chapters-empty')).toBeTruthy();
    expect(screen.queryByTestId('chapters-list')).toBeNull();
  });

  it('renders the chapter list with status/progress facts and entry check runs', async () => {
    scriptEngine({ checkChapters: [] });
    renderChapters();

    await vi.waitFor(() => expect(screen.getByTestId('chapters-list')).toBeTruthy());
    const rows = screen.getAllByTestId(/^chapter-row-/);
    expect(rows).toHaveLength(3);
    expect(screen.getByTestId('chapter-row-1').textContent).toContain('The Arrival');
    expect(screen.getByTestId('chapter-row-2').textContent).toContain('v2');
    expect(screen.getByTestId('chapter-row-2').textContent).toContain('user');
    expect(screen.getByTestId('chapters-progress').textContent).toContain('3/12');
    expect(screen.getByTestId('chapters-progress').textContent).toContain('chapter 4');
    expect(screen.getByTestId('chapters-progress').textContent).toContain('1 pending');

    // Screen entry ran the revision check (chapters.changed = [] → up to date).
    await vi.waitFor(() => expect(countOf('chapter.revisions.check')).toBe(1));
    expect(screen.getByTestId('revisions-uptodate')).toBeTruthy();
  });

  it('selecting a chapter reads and renders it as markdown', async () => {
    scriptEngine();
    renderChapters();
    await vi.waitFor(() => expect(screen.getByTestId('chapters-list')).toBeTruthy());

    await fireEvent.click(screen.getByTestId('chapter-row-1'));
    await vi.waitFor(() => expect(screen.getByTestId('chapter-content')).toBeTruthy());
    const content = screen.getByTestId('chapter-content');
    expect(content.querySelector('h1')?.textContent).toContain('Chapter 1');
    expect(content.querySelector('strong')?.textContent).toBe('one by one');
    expect(screen.getByTestId('chapter-view-title').textContent).toContain('v4');
    expect(payloadOf('chapter.read')).toEqual({ chapter: 1 });
  });

  it('chapter read failures surface the structured error', async () => {
    scriptEngine({}, {
      'chapter.read': () => {
        throw { code: 'operation_failed', message: 'chapter 99 not found' };
      },
    });
    renderChapters();
    await vi.waitFor(() => expect(screen.getByTestId('chapters-list')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('chapter-row-1'));
    await vi.waitFor(() => expect(screen.getByTestId('chapters-reader-error')).toBeTruthy());
    expect(screen.getByTestId('chapters-reader-error').textContent).toContain('chapter 99 not found');
    expect(screen.getByTestId('chapters-reader-error').textContent).toContain('[operation_failed]');
  });
});

describe('chapters screen — edit + save', () => {
  it('edit → dirty indicator → save sends base_version and clears dirty', async () => {
    scriptEngine();
    renderChapters();
    await openFirstChapter();

    await fireEvent.click(screen.getByTestId('chapter-edit'));
    const editor = (await screen.findByTestId('chapter-editor')) as HTMLTextAreaElement;
    expect(screen.queryByTestId('chapter-dirty-indicator')).toBeNull();
    expect(screen.getByTestId('chapter-save').hasAttribute('disabled')).toBe(true);

    await fireEvent.input(editor, { target: { value: '# Chapter 1\n\nEdited opening.' } });
    await vi.waitFor(() => expect(screen.getByTestId('chapter-dirty-indicator')).toBeTruthy());
    expect(screen.getByTestId('chapter-save').hasAttribute('disabled')).toBe(false);

    await fireEvent.click(screen.getByTestId('chapter-save'));
    await vi.waitFor(() => expect(countOf('chapter.save')).toBe(1));
    expect(payloadOf('chapter.save')).toEqual({
      chapter: 1,
      content: '# Chapter 1\n\nEdited opening.',
      base_version: 4,
    });
    await vi.waitFor(() => expect(screen.queryByTestId('chapter-dirty-indicator')).toBeNull());
    // The engine's chapter.updated echo arrives; the list refreshes.
    apply('chapter.updated', 20, { chapter: 1, version: 5, status: 'saved' });
    await vi.waitFor(() => expect(countOf('chapter.list')).toBeGreaterThanOrEqual(2));
  });

  it('non-conflict save error shows the structured error and keeps the draft', async () => {
    scriptEngine({ saveBehavior: 'host_busy' });
    renderChapters();
    await openFirstChapter();
    await fireEvent.click(screen.getByTestId('chapter-edit'));
    const editor = (await screen.findByTestId('chapter-editor')) as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: 'edited while running' } });
    await fireEvent.click(screen.getByTestId('chapter-save'));

    await vi.waitFor(() => expect(screen.getByTestId('chapters-reader-error')).toBeTruthy());
    expect(screen.getByTestId('chapters-reader-error').textContent).toContain('[host_busy]');
    expect((screen.getByTestId('chapter-editor') as HTMLTextAreaElement).value).toBe('edited while running');
  });

  it('conflict → reload engine version (explicit discard of my edits)', async () => {
    scriptEngine({ saveBehavior: 'conflict' });
    renderChapters();
    await openFirstChapter();
    await fireEvent.click(screen.getByTestId('chapter-edit'));
    const editor = (await screen.findByTestId('chapter-editor')) as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: 'my doomed edit' } });
    await fireEvent.click(screen.getByTestId('chapter-save'));

    await vi.waitFor(() => expect(screen.getByTestId('chapter-conflict')).toBeTruthy());
    expect(screen.getByTestId('chapter-conflict').textContent).toContain('current version=6');
    await fireEvent.click(screen.getByTestId('conflict-reload'));

    await vi.waitFor(() => expect(screen.queryByTestId('chapter-conflict')).toBeNull());
    expect((screen.getByTestId('chapter-editor') as HTMLTextAreaElement).value).toContain('harbour lights');
    expect(screen.queryByTestId('chapter-dirty-indicator')).toBeNull();
  });

  it('conflict → review engine version → overwrite on the engine revision', async () => {
    let conflicted = false;
    scriptEngine({ readVersion: 4 }, {
      'chapter.save': (payload) => {
        if (!conflicted) {
          conflicted = true;
          throw {
            code: 'operation_failed',
            message: 'chapter 1 was modified concurrently (base_version=4, current version=6)',
            details: { conflict: true, current_version: 6 },
          };
        }
        return { chapter: payload.chapter, version: 7, saved: true };
      },
      'chapter.read': (payload) => ({
        chapter: payload.chapter,
        content: conflicted ? '# Chapter 1\n\nThe engine rewrote this.' : '# Chapter 1\n\nOriginal.',
        words: 42,
        version: conflicted ? 6 : 4,
        origin: 'engine',
      }),
    });
    renderChapters();
    await openFirstChapter();
    await fireEvent.click(screen.getByTestId('chapter-edit'));
    const editor = (await screen.findByTestId('chapter-editor')) as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: 'my reviewed edit' } });
    await fireEvent.click(screen.getByTestId('chapter-save'));
    await vi.waitFor(() => expect(screen.getByTestId('chapter-conflict')).toBeTruthy());

    await fireEvent.click(screen.getByTestId('conflict-review'));
    await vi.waitFor(() => expect(screen.getByTestId('conflict-engine-content')).toBeTruthy());
    expect(screen.getByTestId('conflict-engine-content').textContent).toContain('engine rewrote this');

    await fireEvent.click(screen.getByTestId('conflict-overwrite'));
    await vi.waitFor(() => expect(countOf('chapter.save')).toBe(2));
    expect(payloadOf('chapter.save', 1)).toEqual({ chapter: 1, content: 'my reviewed edit', base_version: 6 });
    await vi.waitFor(() => expect(screen.queryByTestId('chapter-conflict')).toBeNull());
    expect(screen.queryByTestId('chapter-dirty-indicator')).toBeNull();
  });

  it('stale warning appears when the engine syncs the open chapter during editing', async () => {
    scriptEngine();
    renderChapters();
    await openFirstChapter();
    await fireEvent.click(screen.getByTestId('chapter-edit'));
    const editor = (await screen.findByTestId('chapter-editor')) as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: 'mid-edit' } });

    apply('chapter.updated', 30, { chapter: 1, version: 9, status: 'synced' });
    await vi.waitFor(() => expect(screen.getByTestId('chapter-stale-warning')).toBeTruthy());
    expect((screen.getByTestId('chapter-editor') as HTMLTextAreaElement).value).toBe('mid-edit');
  });
});

describe('chapters screen — dirty protection on navigation', () => {
  async function dirtyTheEditor(): Promise<void> {
    scriptEngine();
    render(AppShell);
    await vi.waitFor(() => expect(screen.getByTestId('chapters-list')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('chapter-row-1'));
    await vi.waitFor(() => expect(screen.getByTestId('chapter-content')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('chapter-edit'));
    const editor = (await screen.findByTestId('chapter-editor')) as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: 'unsaved changes' } });
    await vi.waitFor(() => expect(screen.getByTestId('chapter-dirty-indicator')).toBeTruthy());
  }

  it('nav click with dirty edits raises the guard card and blocks the route', async () => {
    await dirtyTheEditor();
    await fireEvent.click(screen.getByTestId('nav-overview'));
    await vi.waitFor(() => expect(screen.getByTestId('unsaved-guard')).toBeTruthy());
    expect(get(currentRoute)).toBe('chapters');
    expect(screen.getByTestId('unsaved-guard').textContent).toContain('Unsaved changes in chapter 1');
  });

  it('guard: save & continue saves and completes the navigation', async () => {
    await dirtyTheEditor();
    await fireEvent.click(screen.getByTestId('nav-overview'));
    await fireEvent.click(screen.getByTestId('guard-save-proceed'));
    await vi.waitFor(() => expect(countOf('chapter.save')).toBe(1));
    await vi.waitFor(() => expect(get(currentRoute)).toBe('overview'));
    await vi.waitFor(() => expect(screen.queryByTestId('unsaved-guard')).toBeNull());
  });

  it('guard: discard & continue drops the edits and completes the navigation', async () => {
    await dirtyTheEditor();
    await fireEvent.click(screen.getByTestId('nav-write'));
    await fireEvent.click(screen.getByTestId('guard-discard-proceed'));
    await vi.waitFor(() => expect(get(currentRoute)).toBe('write'));
    expect(countOf('chapter.save')).toBe(0);
  });

  it('guard: keep editing stays on the chapters screen with edits intact', async () => {
    await dirtyTheEditor();
    await fireEvent.click(screen.getByTestId('nav-overview'));
    await fireEvent.click(screen.getByTestId('guard-stay'));
    await tick();
    expect(get(currentRoute)).toBe('chapters');
    expect(screen.queryByTestId('unsaved-guard')).toBeNull();
    expect((screen.getByTestId('chapter-editor') as HTMLTextAreaElement).value).toBe('unsaved changes');
  });

  it('navigation with no edits switches immediately', async () => {
    scriptEngine();
    render(AppShell);
    await vi.waitFor(() => expect(screen.getByTestId('chapters-list')).toBeTruthy());
    navigate('overview');
    expect(get(currentRoute)).toBe('overview');
  });

  it('switching chapters with edits goes through the guard too', async () => {
    await dirtyTheEditor();
    await fireEvent.click(screen.getByTestId('chapter-row-2'));
    await vi.waitFor(() => expect(screen.getByTestId('unsaved-guard')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('guard-discard-proceed'));
    await vi.waitFor(() => expect(screen.getByTestId('chapter-view-title').textContent).toContain('Chapter 2'));
  });
});

describe('chapters screen — revisions panel', () => {
  it('check on demand lists changed chapters with per-chapter and sync-all actions', async () => {
    let checks = 0;
    scriptEngine({}, {
      'chapter.revisions.check': () => {
        checks += 1;
        return checks === 1 ? { chapters: [], count: 0 } : { chapters: [3, 7], count: 2 };
      },
    });
    renderChapters();
    await vi.waitFor(() => expect(countOf('chapter.revisions.check')).toBe(1));
    // The engine now reports changed chapters on the next check.
    await fireEvent.click(screen.getByTestId('revisions-check-button'));
    await vi.waitFor(() => expect(screen.getByTestId('revisions-changed')).toBeTruthy());
    expect(screen.getByTestId('revisions-changed').textContent).toContain('Chapter 3');
    expect(screen.getByTestId('revisions-changed').textContent).toContain('Chapter 7');
    expect(screen.getByTestId('revisions-sync-one-3')).toBeTruthy();
    expect(screen.getByTestId('revisions-sync-all')).toBeTruthy();
  });

  it('sync flow: confirmation states the scope; applied facts tick up; completion shows the result', async () => {
    scriptEngine({ checkChapters: [3, 7] });
    renderChapters();
    await vi.waitFor(() => expect(screen.getByTestId('revisions-changed')).toBeTruthy());

    await fireEvent.click(screen.getByTestId('revisions-sync-all'));
    await vi.waitFor(() => expect(screen.getByTestId('revisions-confirm')).toBeTruthy());
    // Nothing sent before confirmation.
    expect(countOf('chapter.revisions.sync')).toBe(0);
    expect(screen.getByTestId('revisions-confirm-scope').textContent).toContain('2 chapters');
    expect(screen.getByTestId('revisions-confirm-scope').textContent).toContain('3, 7');

    await fireEvent.click(screen.getByTestId('revisions-confirm-yes'));
    await vi.waitFor(() => expect(screen.getByTestId('revisions-syncing')).toBeTruthy());
    expect(payloadOf('chapter.revisions.sync')).toEqual({});
    expect(screen.getByTestId('revisions-syncing').textContent).toContain('0/2');

    apply('chapter.updated', 40, { chapter: 3, status: 'synced' });
    await vi.waitFor(() => expect(screen.getByTestId('revisions-syncing').textContent).toContain('1/2'));
    apply('chapter.updated', 41, { chapter: 7, status: 'synced' });
    await vi.waitFor(() => expect(screen.getByTestId('revisions-sync-completed')).toBeTruthy());
    expect(screen.getByTestId('revisions-sync-completed').textContent).toContain('3, 7');
  });

  it('sync cancel sends nothing', async () => {
    scriptEngine({ checkChapters: [3] });
    renderChapters();
    await vi.waitFor(() => expect(screen.getByTestId('revisions-changed')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('revisions-sync-all'));
    await fireEvent.click(screen.getByTestId('revisions-confirm-cancel'));
    await vi.waitFor(() => expect(screen.queryByTestId('revisions-confirm')).toBeNull());
    expect(countOf('chapter.revisions.sync')).toBe(0);
  });

  it('host_busy rejection is surfaced as a structured failure', async () => {
    scriptEngine({ checkChapters: [3], syncBehavior: 'host_busy' });
    renderChapters();
    await vi.waitFor(() => expect(screen.getByTestId('revisions-changed')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('revisions-sync-all'));
    await fireEvent.click(screen.getByTestId('revisions-confirm-yes'));
    await vi.waitFor(() => expect(screen.getByTestId('revisions-sync-failed')).toBeTruthy());
    expect(screen.getByTestId('revisions-sync-failed').textContent).toContain('[host_busy]');
    expect(screen.getByTestId('revisions-sync-failed').textContent).toContain('Engine busy');
  });

  it('sync failure via engine.error event is surfaced', async () => {
    scriptEngine({ checkChapters: [3] });
    renderChapters();
    await vi.waitFor(() => expect(screen.getByTestId('revisions-changed')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('revisions-sync-all'));
    await fireEvent.click(screen.getByTestId('revisions-confirm-yes'));
    await vi.waitFor(() => expect(screen.getByTestId('revisions-syncing')).toBeTruthy());

    apply('engine.error', 50, { code: 'operation_failed', message: 'revision sync failed: provider down' });
    await vi.waitFor(() => expect(screen.getByTestId('revisions-sync-failed')).toBeTruthy());
    expect(screen.getByTestId('revisions-sync-failed').textContent).toContain('revision sync failed');
  });

  it('check error is presented with the catalog title', async () => {
    scriptEngine({}, {
      'chapter.revisions.check': () => {
        throw { code: 'host_busy', message: 'a generation run is already active' };
      },
    });
    renderChapters();
    await vi.waitFor(() => expect(screen.getByTestId('revisions-check-error')).toBeTruthy());
    expect(screen.getByTestId('revisions-check-error').textContent).toContain('[host_busy]');
  });
});
