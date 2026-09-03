/**
 * Chapters controller tests (module level, driven through the scripted
 * Tauri bridge + stores): chapter list projection, editor dirty state,
 * base_version save + conflict resolution (reload / review-then-overwrite),
 * unsaved-change guards (switch / close / navigation), and the revision
 * check → sync flow with acceptance semantics (chapter.updated synced facts,
 * completion notification matched structurally, engine.error failure).
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

import { get } from 'svelte/store';

import {
  beginConflictReview,
  cancelRevisionSync,
  chapterEditor,
  chapterGuard,
  chapterListState,
  closeEditor,
  confirmRevisionSync,
  editDraft,
  editorDirty,
  enterChaptersScreen,
  guardDiscardAndProceed,
  guardSaveAndProceed,
  guardStay,
  openChapter,
  overwriteAfterReview,
  refreshChapterList,
  requestRevisionSync,
  resetChaptersState,
  resolveConflictReload,
  revisionCheck,
  revisionSync,
  runRevisionCheck,
  saveEditor,
  stopEditing,
} from '$lib/chapters';
import { blockedNavigation, currentRoute, navigate } from '$lib/routes';
import {
  applyEngineEvent,
  connectionState,
  disposeDesktop,
  notifications,
  projectSnapshot,
} from '$lib/stores/desktop';
import { engineEvent, installBridgeMarker, tauri } from '$tests/tauri-mock';
import type { EventEnvelope } from '$lib/types/protocol';

const SNAPSHOT = { book_title: 'The Lantern Sea', total_chapters: 12, completed_chapters: 3 };

const LIST = {
  chapters: [
    { chapter: 1, title: 'The Arrival', words: 3200, version: 4, origin: 'engine', status: 'saved' },
    { chapter: 2, title: 'First Light', words: 2800, version: 2, origin: 'user', status: 'saved' },
    { chapter: 3, words: 1900, version: 1, status: 'saved' },
  ],
  completed: 3,
  total: 12,
  in_progress: 4,
  pending_rewrites: 1,
};

function scriptEngine(overrides: Record<string, (payload: Record<string, unknown>) => unknown> = {}): void {
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    const payload = (args as { payload?: Record<string, unknown> })?.payload ?? {};
    switch (method) {
      case 'chapter.list':
        return overrides['chapter.list'] ? overrides['chapter.list'](payload) : LIST;
      case 'chapter.read':
        return overrides['chapter.read']
          ? overrides['chapter.read'](payload)
          : { chapter: payload.chapter, content: '# Chapter text\n\nIt was a dark...', words: 12, version: 7, origin: 'engine' };
      case 'chapter.save':
        return overrides['chapter.save'] ? overrides['chapter.save'](payload) : { chapter: payload.chapter, version: 8, saved: true };
      case 'chapter.revisions.check':
        return overrides['chapter.revisions.check'] ? overrides['chapter.revisions.check'](payload) : { chapters: [3, 7], count: 2 };
      case 'chapter.revisions.sync':
        return overrides['chapter.revisions.sync'] ? overrides['chapter.revisions.sync'](payload) : { accepted: true, changed: [3, 7] };
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
  const calls = tauri
    .callsOf('desktop_request')
    .filter((c) => (c.args as { method?: string })?.method === method);
  const call = index < 0 ? calls[calls.length - 1] : calls[index];
  return (call?.args as { payload?: Record<string, unknown> })?.payload ?? {};
}

function countOf(method: string): number {
  return tauri.callsOf('desktop_request').filter((c) => (c.args as { method?: string })?.method === method).length;
}

function apply(event: string, sequence: number, payload: Record<string, unknown> = {}): void {
  applyEngineEvent(engineEvent(event, sequence, payload, 'sess-1') as unknown as EventEnvelope);
}

beforeEach(async () => {
  tauri.reset();
  await disposeDesktop();
  resetChaptersState();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
  currentRoute.set('chapters');
});

describe('chapter list projection', () => {
  it('loads, sorts by chapter number, and projects the engine counters', async () => {
    scriptEngine();
    await refreshChapterList();
    const state = get(chapterListState);
    expect(state.items.map((i) => i.chapter)).toEqual([1, 2, 3]);
    expect(state.error).toBeNull();
    expect(state.completed).toBe(3);
    expect(state.total).toBe(12);
    expect(state.inProgress).toBe(4);
    expect(state.pendingRewrites).toBe(1);
  });

  it('project_unavailable clears the list silently (no project open)', async () => {
    scriptEngine({
      'chapter.list': () => {
        throw { code: 'project_unavailable', message: 'no project is open' };
      },
    });
    await refreshChapterList();
    expect(get(chapterListState).items).toEqual([]);
    expect(get(chapterListState).error).toBeNull();
  });

  it('other failures are recorded structurally', async () => {
    scriptEngine({
      'chapter.list': () => {
        throw { code: 'engine_unavailable', message: 'engine died' };
      },
    });
    await refreshChapterList();
    expect(get(chapterListState).error?.code).toBe('engine_unavailable');
  });
});

describe('editor: read, dirty, save', () => {
  it('reads a chapter and tracks the engine version as the save baseline', async () => {
    scriptEngine();
    openChapter(2);
    await vi.waitFor(() => expect(get(chapterEditor).baseline).not.toBeNull());
    expect(get(chapterEditor).chapter).toBe(2);
    expect(get(chapterEditor).baseline?.version).toBe(7);
    expect(get(editorDirty)).toBe(false);
    expect(payloadOf('chapter.read')).toEqual({ chapter: 2 });
  });

  it('dirty tracks edits; save sends content with base_version and rebases', async () => {
    scriptEngine();
    openChapter(1);
    await vi.waitFor(() => expect(get(chapterEditor).baseline).not.toBeNull());
    editDraft('# Chapter text\n\nEdited by the user.');
    expect(get(editorDirty)).toBe(true);

    expect(await saveEditor()).toBe(true);
    expect(payloadOf('chapter.save')).toEqual({
      chapter: 1,
      content: '# Chapter text\n\nEdited by the user.',
      base_version: 7,
    });
    const state = get(chapterEditor);
    expect(get(editorDirty)).toBe(false);
    expect(state.baseline?.version).toBe(8);
    expect(state.lastSaved?.version).toBe(8);
    expect(state.conflict).toBeNull();
    // The list projection refreshes after a save.
    await vi.waitFor(() => expect(countOf('chapter.list')).toBe(1));
  });

  it('a save without edits is a no-op (no request)', async () => {
    scriptEngine();
    openChapter(1);
    await vi.waitFor(() => expect(get(chapterEditor).baseline).not.toBeNull());
    expect(await saveEditor()).toBe(false);
    expect(countOf('chapter.save')).toBe(0);
  });

  it('non-conflict save failures surface the structured error and keep the draft', async () => {
    scriptEngine({
      'chapter.save': () => {
        throw { code: 'host_busy', message: 'a generation run is already active' };
      },
    });
    openChapter(1);
    await vi.waitFor(() => expect(get(chapterEditor).baseline).not.toBeNull());
    editDraft('changed text');
    expect(await saveEditor()).toBe(false);
    const state = get(chapterEditor);
    expect(state.error?.code).toBe('host_busy');
    expect(get(editorDirty)).toBe(true);
    expect(state.draft).toBe('changed text');
  });
});

describe('base_version conflict resolution', () => {
  function conflictSave(): void {
    scriptEngine({
      'chapter.save': () => {
        throw {
          code: 'operation_failed',
          message: 'chapter 1 was modified concurrently (base_version=7, current version=9)',
          details: { conflict: true, current_version: 9 },
        };
      },
    });
  }

  it('a structured conflict parks the editor in the conflict state (no toast churn, draft kept)', async () => {
    conflictSave();
    openChapter(1);
    await vi.waitFor(() => expect(get(chapterEditor).baseline).not.toBeNull());
    editDraft('my precious edit');
    expect(await saveEditor()).toBe(false);

    const state = get(chapterEditor);
    expect(state.conflict).not.toBeNull();
    expect(state.conflict?.engineVersion).toBe(9);
    expect(state.conflict?.engineContent).toBeNull();
    expect(state.draft).toBe('my precious edit');
    expect(get(editorDirty)).toBe(true);
    // Not presented as a generic error: it has its own resolution flow.
    expect(state.error).toBeNull();
  });

  it('reload: re-reads the engine version, discarding local edits', async () => {
    conflictSave();
    openChapter(1);
    await vi.waitFor(() => expect(get(chapterEditor).baseline).not.toBeNull());
    editDraft('my precious edit');
    await saveEditor();
    expect(get(chapterEditor).conflict).not.toBeNull();

    await resolveConflictReload();
    const state = get(chapterEditor);
    expect(state.conflict).toBeNull();
    expect(state.baseline?.content).toBe('# Chapter text\n\nIt was a dark...');
    expect(state.draft).toBe('# Chapter text\n\nIt was a dark...');
    expect(get(editorDirty)).toBe(false);
  });

  it('review then overwrite: fetches the engine text, then saves on the engine revision', async () => {
    const saves: Array<Record<string, unknown>> = [];
    let saveAttempt = 0;
    let conflictHappened = false;
    scriptEngine({
      // After the conflict the engine is at v9; reads reflect that.
      'chapter.read': (payload) =>
        conflictHappened
          ? { chapter: payload.chapter, content: '# Engine rewrote this\n\nnewer text', words: 10, version: 9 }
          : { chapter: payload.chapter, content: '# Chapter text\n\nIt was a dark...', words: 12, version: 7 },
      'chapter.save': (payload) => {
        saveAttempt += 1;
        saves.push(payload);
        if (saveAttempt === 1) {
          conflictHappened = true;
          throw {
            code: 'operation_failed',
            message: 'concurrent modification',
            details: { conflict: true, current_version: 9 },
          };
        }
        return { chapter: payload.chapter, version: 10, saved: true };
      },
    });
    openChapter(1);
    await vi.waitFor(() => expect(get(chapterEditor).baseline).not.toBeNull());
    editDraft('the fix');
    await saveEditor();
    expect(get(chapterEditor).conflict).not.toBeNull();

    await beginConflictReview();
    expect(get(chapterEditor).conflict?.engineContent).toBe('# Engine rewrote this\n\nnewer text');

    expect(await overwriteAfterReview()).toBe(true);
    // Overwrite re-based on the engine's conflicting revision.
    expect(saves[1]).toEqual({ chapter: 1, content: 'the fix', base_version: 9 });
    const state = get(chapterEditor);
    expect(state.conflict).toBeNull();
    expect(state.baseline?.version).toBe(10);
    expect(get(editorDirty)).toBe(false);
  });

  it('a second conflict during overwrite re-offers resolution at the newer revision', async () => {
    let saveAttempt = 0;
    scriptEngine({
      'chapter.save': () => {
        saveAttempt += 1;
        throw {
          code: 'operation_failed',
          message: `concurrent (attempt ${saveAttempt})`,
          details: { conflict: true, current_version: 9 + saveAttempt },
        };
      },
    });
    openChapter(1);
    await vi.waitFor(() => expect(get(chapterEditor).baseline).not.toBeNull());
    editDraft('edit');
    await saveEditor();
    await beginConflictReview();
    expect(await overwriteAfterReview()).toBe(false);
    expect(get(chapterEditor).conflict?.engineVersion).toBe(11);
    expect(get(editorDirty)).toBe(true);
  });
});

describe('unsaved-change guards', () => {
  async function dirtyEditor(): Promise<void> {
    scriptEngine();
    openChapter(1);
    await vi.waitFor(() => expect(get(chapterEditor).baseline).not.toBeNull());
    editDraft('unsaved work');
    expect(get(editorDirty)).toBe(true);
  }

  it('switching chapters with edits raises the guard; stay keeps the edits', async () => {
    await dirtyEditor();
    openChapter(2);
    expect(get(chapterGuard)).toEqual({ kind: 'switch', targetChapter: 2 });
    expect(get(chapterEditor).chapter).toBe(1); // unchanged
    expect(countOf('chapter.read')).toBe(1); // no second read

    guardStay();
    expect(get(chapterGuard)).toBeNull();
    expect(get(chapterEditor).draft).toBe('unsaved work');
  });

  it('discard and proceed reverts to the baseline and performs the switch', async () => {
    await dirtyEditor();
    openChapter(2);
    guardDiscardAndProceed();
    expect(get(chapterGuard)).toBeNull();
    expect(get(editorDirty)).toBe(false);
    await vi.waitFor(() => expect(get(chapterEditor).chapter).toBe(2));
  });

  it('save and proceed saves first, then performs the action', async () => {
    await dirtyEditor();
    openChapter(2);
    await guardSaveAndProceed();
    expect(payloadOf('chapter.save')).toMatchObject({ chapter: 1, base_version: 7 });
    expect(get(chapterGuard)).toBeNull();
    await vi.waitFor(() => expect(get(chapterEditor).chapter).toBe(2));
  });

  it('save-and-proceed that hits a conflict keeps you on the chapter (conflict presented)', async () => {
    scriptEngine({
      'chapter.save': () => {
        throw { code: 'operation_failed', message: 'concurrent', details: { conflict: true, current_version: 9 } };
      },
    });
    openChapter(1);
    await vi.waitFor(() => expect(get(chapterEditor).baseline).not.toBeNull());
    editDraft('unsaved work');
    openChapter(2);
    await guardSaveAndProceed();
    expect(get(chapterGuard)).toBeNull();
    expect(get(chapterEditor).chapter).toBe(1);
    expect(get(chapterEditor).conflict).not.toBeNull();
  });

  it('closing the editor with edits raises the guard; discard closes', async () => {
    await dirtyEditor();
    closeEditor();
    expect(get(chapterGuard)).toEqual({ kind: 'close' });
    guardDiscardAndProceed();
    expect(get(chapterEditor).chapter).toBeNull();
    expect(get(chapterGuard)).toBeNull();
  });

  it('stop-editing with edits raises the guard and keeps the reader open on discard', async () => {
    await dirtyEditor();
    stopEditing();
    expect(get(chapterGuard)).toEqual({ kind: 'stop-edit' });
    guardDiscardAndProceed();
    expect(get(chapterEditor).chapter).toBe(1);
    expect(get(editorDirty)).toBe(false);
  });

  it('route navigation with edits is blocked and completes after discard', async () => {
    // The chapters module arms its guard on screen entry (mirrored here).
    enterChaptersScreen();
    await dirtyEditor();

    navigate('overview');
    expect(get(currentRoute)).toBe('chapters'); // blocked
    expect(get(blockedNavigation)?.target).toBe('overview');
    expect(get(chapterGuard)).toEqual({ kind: 'navigate', target: 'overview' });

    guardDiscardAndProceed();
    expect(get(currentRoute)).toBe('overview');
    expect(get(blockedNavigation)).toBeNull();
  });

  it('stay cancels the blocked navigation too', async () => {
    enterChaptersScreen();
    await refreshChapterList();
    await dirtyEditor();
    navigate('write');
    guardStay();
    expect(get(currentRoute)).toBe('chapters');
    expect(get(blockedNavigation)).toBeNull();
  });

  it('navigation without edits passes straight through', async () => {
    enterChaptersScreen();
    navigate('overview');
    expect(get(currentRoute)).toBe('overview');
    expect(get(chapterGuard)).toBeNull();
  });
});

describe('engine-driven chapter updates under the editor', () => {
  it('a clean view silently picks up engine changes; our own save echo is not a reload', async () => {
    scriptEngine();
    openChapter(1);
    await vi.waitFor(() => expect(get(chapterEditor).baseline).not.toBeNull());
    const readsBefore = countOf('chapter.read');

    apply('chapter.updated', 10, { chapter: 1, version: 11, status: 'synced' });
    await vi.waitFor(() => expect(countOf('chapter.read')).toBe(readsBefore + 1));
    expect(get(chapterEditor).baseline?.version).toBe(7); // scripted read is static; re-read happened

    // Own save: the echo of chapter.updated must NOT trigger another read.
    editDraft('edit');
    await saveEditor();
    const readsAfterSave = countOf('chapter.read');
    apply('chapter.updated', 12, { chapter: 1, version: 8, status: 'saved' });
    await vi.waitFor(() => expect(get(chapterListState).loading === false));
    expect(countOf('chapter.read')).toBe(readsAfterSave);
  });

  it('dirty edits get a stale warning instead of a silent overwrite', async () => {
    scriptEngine();
    openChapter(1);
    await vi.waitFor(() => expect(get(chapterEditor).baseline).not.toBeNull());
    editDraft('my edit');
    const readsBefore = countOf('chapter.read');
    apply('chapter.updated', 10, { chapter: 1, version: 11, status: 'synced' });
    expect(get(chapterEditor).staleWarning).toBe(true);
    expect(get(chapterEditor).draft).toBe('my edit');
    expect(countOf('chapter.read')).toBe(readsBefore); // no silent reload
  });

  it('chapter.updated for another chapter does not touch the editor', async () => {
    scriptEngine();
    openChapter(1);
    await vi.waitFor(() => expect(get(chapterEditor).baseline).not.toBeNull());
    apply('chapter.updated', 10, { chapter: 5, version: 2, status: 'saved' });
    expect(get(chapterEditor).staleWarning).toBe(false);
  });
});

describe('revisions: check + sync', () => {
  it('check projects the changed chapters', async () => {
    scriptEngine();
    await runRevisionCheck();
    const state = get(revisionCheck);
    expect(state.status).toBe('idle');
    expect(state.changed).toEqual([3, 7]);
    expect(state.checkedAt).not.toBeNull();
    expect(payloadOf('chapter.revisions.check')).toEqual({});
  });

  it('check can scope to one chapter', async () => {
    scriptEngine();
    await runRevisionCheck(3);
    expect(payloadOf('chapter.revisions.check')).toEqual({ chapter: 3 });
  });

  it('check failure is structured (host_busy during a run)', async () => {
    scriptEngine({
      'chapter.revisions.check': () => {
        throw { code: 'host_busy', message: 'a generation run is already active' };
      },
    });
    await runRevisionCheck();
    expect(get(revisionCheck).error?.code).toBe('host_busy');
    expect(get(revisionCheck).changed).toEqual([]);
  });

  it('sync: confirmation is explicit; acceptance tracks applied chapters via synced facts', async () => {
    scriptEngine();
    await runRevisionCheck();

    requestRevisionSync(); // all changed
    expect(get(revisionSync).status).toBe('confirming');
    expect(get(revisionSync).scope).toEqual([3, 7]);
    expect(countOf('chapter.revisions.sync')).toBe(0); // nothing sent yet

    expect(await confirmRevisionSync()).toBe(true);
    expect(get(revisionSync).status).toBe('syncing');
    expect(payloadOf('chapter.revisions.sync')).toEqual({});

    apply('chapter.updated', 20, { chapter: 3, status: 'synced' });
    expect(get(revisionSync).applied).toEqual([3]);
    expect(get(revisionSync).status).toBe('syncing');

    apply('chapter.updated', 21, { chapter: 7, status: 'synced' });
    expect(get(revisionSync).status).toBe('completed');
    expect(get(revisionSync).applied).toEqual([3, 7]);
  });

  it('sync: terminal notification with details.applied completes it structurally', async () => {
    scriptEngine({
      'chapter.revisions.check': () => ({ chapters: [5], count: 1 }),
      'chapter.revisions.sync': () => ({ accepted: true, changed: [5] }),
    });
    await runRevisionCheck();
    requestRevisionSync(5);
    expect(get(revisionSync).scope).toEqual([5]);
    await confirmRevisionSync();

    apply('notification.info', 30, {
      message: 'revision sync completed: 1 applied',
      details: { applied: [5] },
    });
    expect(get(revisionSync).status).toBe('completed');
    expect(get(revisionSync).applied).toEqual([5]);
    expect(get(revisionSync).message).toContain('1 applied');
  });

  it('sync: engine.error during the window fails the sync with the engine message', async () => {
    scriptEngine();
    await runRevisionCheck();
    requestRevisionSync();
    await confirmRevisionSync();
    apply('engine.error', 40, { code: 'operation_failed', message: 'revision sync failed: provider down' });
    expect(get(revisionSync).status).toBe('failed');
    expect(get(revisionSync).message).toContain('revision sync failed');
  });

  it('sync: synchronous host_busy rejection is surfaced as a structured failure', async () => {
    scriptEngine({
      'chapter.revisions.sync': () => {
        throw { code: 'host_busy', message: 'a generation run is already active', details: { active_request: 'chapter.revisions.sync' } };
      },
    });
    await runRevisionCheck();
    requestRevisionSync();
    expect(await confirmRevisionSync()).toBe(false);
    expect(get(revisionSync).status).toBe('failed');
    expect(get(revisionSync).error?.code).toBe('host_busy');
  });

  it('sync: chapter filter that finds nothing completes synchronously (applied: [])', async () => {
    scriptEngine({
      'chapter.revisions.check': () => ({ chapters: [3], count: 1 }),
      'chapter.revisions.sync': (payload) =>
        payload.chapter === 9 ? { changed: [], applied: [] } : { accepted: true, changed: [3] },
    });
    await runRevisionCheck();
    requestRevisionSync(9); // not in the changed list, but requested explicitly
    expect(await confirmRevisionSync()).toBe(true);
    expect(get(revisionSync).status).toBe('completed');
    expect(get(revisionSync).applied).toEqual([]);
    expect(payloadOf('chapter.revisions.sync')).toEqual({ chapter: 9 });
  });

  it('cancel confirmation sends nothing', async () => {
    scriptEngine();
    await runRevisionCheck();
    requestRevisionSync();
    cancelRevisionSync();
    expect(get(revisionSync).status).toBe('idle');
    expect(countOf('chapter.revisions.sync')).toBe(0);
  });

  it('unrelated notifications never complete a sync', async () => {
    scriptEngine();
    await runRevisionCheck();
    requestRevisionSync();
    await confirmRevisionSync();
    apply('notification.info', 50, { message: 'something else finished' });
    expect(get(revisionSync).status).toBe('syncing');
  });
});

describe('project close resets editor state', () => {
  it('snapshot null drops the editor, guard, list, and revision projections', async () => {
    scriptEngine();
    openChapter(1);
    await vi.waitFor(() => expect(get(chapterEditor).baseline).not.toBeNull());
    editDraft('unsaved');
    projectSnapshot.set(null);
    expect(get(chapterEditor).chapter).toBeNull();
    expect(get(chapterGuard)).toBeNull();
    expect(get(chapterListState).items).toEqual([]);
    expect(get(revisionCheck).changed).toEqual([]);
    expect(notifications !== undefined).toBe(true);
  });
});
