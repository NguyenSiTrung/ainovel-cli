/**
 * Chapter content, revisions, and unsaved-change orchestration for the
 * task-6 screens. Mirrors `runControls.ts`: pure availability/state
 * projections plus command actions that issue exactly one protocol request
 * each and surface structured errors through the shared presentation.
 *
 * Contract honored (task-2 daemon mapping):
 * - `chapter.list` is a read-only projection (number/title/words/version/
 *   origin per completed chapter).
 * - `chapter.read {chapter}` returns the FINAL text; `version` is the accept
 *   record's revision and the base for optimistic locking. There is no
 *   intermediate-artifact read method in desktop-v1 — only the final text is
 *   ever shown (never faked).
 * - `chapter.save {chapter, content, base_version}` — a mismatched
 *   base_version is rejected with operation_failed +
 *   details:{conflict:true, current_version}. Resolution is EXPLICIT:
 *   reload (discard my edits) or review the engine version then overwrite
 *   (re-based on the engine's current revision). Success emits
 *   chapter.updated and returns the new revision.
 * - `chapter.revisions.check` is on-demand and on screen entry; sync is
 *   acceptance-based: applied chapters arrive as chapter.updated
 *   {status:"synced"} facts + a completion notification (details.applied);
 *   failure arrives as engine.error. There is no sync-cancel method in v1.
 *
 * Dirty-state protection: switching chapters, closing the editor, or
 * navigating routes with unsaved edits raises ONE guard (module store) that
 * the shell renders as an explicit save / discard / stay choice. Nothing is
 * ever dropped or auto-saved without the user's decision.
 */

import { get, writable, type Readable, type Writable } from 'svelte/store';

import {
  chapterList as fetchChapterList,
  chapterRead,
  chapterRevisionsCheck,
  chapterRevisionsSync,
  chapterSave,
  conflictCurrentVersion,
  isChapterConflictError,
  type ChapterListItem,
} from '$lib/api/desktop';
import { cancelBlockedNavigation, proceedBlockedNavigation, setNavigationGuard, type RouteId } from '$lib/routes';
import {
  chapterEvents,
  connectionState,
  notifications,
  projectSnapshot,
  reportError,
} from '$lib/stores/desktop';
import type { ChapterUpdateFact, StructuredError } from '$lib/types/protocol';

// ---------------------------------------------------------------------------
// Chapter list projection
// ---------------------------------------------------------------------------

export interface ChapterListState {
  items: ChapterListItem[];
  loading: boolean;
  /** completed/total/in-progress/pendings as reported by chapter.list. */
  completed?: number;
  total?: number;
  inProgress?: number;
  pendingRewrites?: number;
  error: StructuredError | null;
}

export const chapterListState: Writable<ChapterListState> = writable({
  items: [],
  loading: false,
  error: null,
});

export async function refreshChapterList(): Promise<void> {
  chapterListState.update((s) => ({ ...s, loading: true }));
  try {
    const result = await fetchChapterList();
    chapterListState.set({
      items: (result.chapters ?? []).slice().sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0)),
      loading: false,
      completed: result.completed,
      total: result.total,
      inProgress: result.in_progress,
      pendingRewrites: result.pending_rewrites,
      error: null,
    });
  } catch (raw) {
    const structured = reportError(raw, 'chapter.list');
    // No project open: not an error, just nothing to list.
    if (structured.code === 'project_unavailable') {
      chapterListState.set({ items: [], loading: false, error: null });
      return;
    }
    chapterListState.update((s) => ({ ...s, loading: false, error: structured }));
  }
}

// ---------------------------------------------------------------------------
// Editor session (read → edit → save with base_version)
// ---------------------------------------------------------------------------

export interface ChapterConflict {
  /** Engine revision that conflicted with our base_version. */
  engineVersion?: number;
  /** Engine content fetched for review (null until the user asks to review). */
  engineContent: string | null;
  reviewing: boolean;
  message: string;
}

export interface ChapterEditorState {
  chapter: number | null;
  loading: boolean;
  /** Engine truth at load/save time: content + revision baseline. */
  baseline: { content: string; version?: number; words?: number; origin?: string } | null;
  draft: string;
  saving: boolean;
  reloading: boolean;
  error: StructuredError | null;
  conflict: ChapterConflict | null;
  lastSaved: { at: number; version?: number } | null;
  /** The engine saved this chapter (revision sync, run commit) under us. */
  staleWarning: boolean;
}

export const chapterEditor: Writable<ChapterEditorState> = writable({
  chapter: null,
  loading: false,
  baseline: null,
  draft: '',
  saving: false,
  reloading: false,
  error: null,
  conflict: null,
  lastSaved: null,
  staleWarning: false,
});

export const editorDirty: Readable<boolean> = {
  subscribe(run) {
    return chapterEditor.subscribe((state) =>
      run(state.baseline !== null && state.draft !== state.baseline.content),
    );
  },
};

export function editDraft(text: string): void {
  chapterEditor.update((s) => ({ ...s, draft: text }));
}

async function loadChapter(chapter: number): Promise<void> {
  chapterEditor.update((s) => ({ ...s, chapter, loading: true, error: null, conflict: null, staleWarning: false }));
  try {
    const result = await chapterRead(chapter);
    chapterEditor.update((s) => ({
      ...s,
      loading: false,
      baseline: {
        content: result.content ?? '',
        version: result.version,
        words: result.words,
        origin: result.origin,
      },
      draft: result.content ?? '',
    }));
  } catch (raw) {
    const structured = reportError(raw, `chapter.read (${chapter})`);
    chapterEditor.update((s) => ({
      ...s,
      loading: false,
      error: structured,
      baseline: null,
      draft: '',
    }));
  }
}

/** Open a chapter for reading. Dirty edits demand an explicit decision first. */
export function openChapter(chapter: number): void {
  if (get(editorDirty)) {
    chapterGuard.set({ kind: 'switch', targetChapter: chapter });
    return;
  }
  void loadChapter(chapter);
}

/** Close the reader/editor. Dirty edits demand an explicit decision first. */
export function closeEditor(): void {
  if (get(editorDirty)) {
    chapterGuard.set({ kind: 'close' });
    return;
  }
  resetEditor();
}

/** Leave edit mode. Dirty edits demand an explicit decision first. */
export function stopEditing(): void {
  if (get(editorDirty)) {
    chapterGuard.set({ kind: 'stop-edit' });
    return;
  }
  chapterEditor.update((s) => ({ ...s, draft: s.baseline?.content ?? '', conflict: null, staleWarning: false }));
}

function resetEditor(): void {
  chapterEditor.set({
    chapter: null,
    loading: false,
    baseline: null,
    draft: '',
    saving: false,
    reloading: false,
    error: null,
    conflict: null,
    lastSaved: null,
    staleWarning: false,
  });
}

/**
 * Save the draft. Sends the baseline revision as base_version so the engine
 * can reject concurrent modification; a conflict is presented explicitly
 * (reload vs review-and-overwrite), never silently retried.
 */
export async function saveEditor(): Promise<boolean> {
  const state = get(chapterEditor);
  if (state.chapter === null || state.baseline === null || state.saving) return false;
  if (state.draft === state.baseline.content) return false;
  chapterEditor.update((s) => ({ ...s, saving: true, error: null }));
  try {
    const result = await chapterSave(state.chapter, state.draft, state.baseline.version);
    // Our save's chapter.updated echo (matched by version when reported).
    suppressEchoFor = { chapter: state.chapter, version: result.version };
    chapterEditor.update((s) => ({
      ...s,
      saving: false,
      conflict: null,
      staleWarning: false,
      baseline: { content: s.draft, version: result.version ?? (s.baseline?.version ?? 0) + 1 },
      lastSaved: { at: Date.now(), version: result.version },
    }));
    void refreshChapterList();
    return true;
  } catch (raw) {
    if (isChapterConflictError(raw)) {
      // Structured conflict: offer the explicit resolution paths. The panel
      // is the presentation (no toast — the engine kept our text).
      chapterEditor.update((s) => ({
        ...s,
        saving: false,
        conflict: {
          engineVersion: conflictCurrentVersion(raw),
          engineContent: null,
          reviewing: false,
          message: raw instanceof Error ? raw.message : 'chapter was modified concurrently',
        },
      }));
      return false;
    }
    const structured = reportError(raw, 'chapter.save');
    chapterEditor.update((s) => ({ ...s, saving: false, error: structured }));
    return false;
  }
}

/** Conflict resolution A: reload the engine version, discarding my edits. */
export async function resolveConflictReload(): Promise<void> {
  const state = get(chapterEditor);
  if (state.chapter === null || !state.conflict) return;
  chapterEditor.update((s) => ({ ...s, reloading: true }));
  try {
    const result = await chapterRead(state.chapter);
    chapterEditor.update((s) => ({
      ...s,
      reloading: false,
      conflict: null,
      staleWarning: false,
      baseline: {
        content: result.content ?? '',
        version: result.version,
        words: result.words,
        origin: result.origin,
      },
      draft: result.content ?? '',
    }));
    void refreshChapterList();
  } catch (raw) {
    reportError(raw, 'chapter.read (conflict reload)');
    chapterEditor.update((s) => ({ ...s, reloading: false }));
  }
}

/** Conflict resolution B step 1: fetch the engine version for review. */
export async function beginConflictReview(): Promise<void> {
  const state = get(chapterEditor);
  if (state.chapter === null || !state.conflict) return;
  chapterEditor.update((s) => ({ ...s, conflict: s.conflict ? { ...s.conflict, reviewing: true } : null }));
  try {
    const result = await chapterRead(state.chapter);
    chapterEditor.update((s) => ({
      ...s,
      conflict: s.conflict
        ? {
            ...s.conflict,
            reviewing: false,
            engineContent: result.content ?? '',
            engineVersion: result.version ?? s.conflict.engineVersion,
          }
        : null,
    }));
  } catch (raw) {
    reportError(raw, 'chapter.read (conflict review)');
    chapterEditor.update((s) => ({ ...s, conflict: s.conflict ? { ...s.conflict, reviewing: false } : null }));
  }
}

/** Conflict resolution B step 2 (after review): overwrite on the engine's revision. */
export async function overwriteAfterReview(): Promise<boolean> {
  const state = get(chapterEditor);
  if (state.chapter === null || state.baseline === null || !state.conflict) return false;
  const baseVersion = state.conflict.engineVersion ?? state.baseline.version;
  chapterEditor.update((s) => ({ ...s, saving: true, error: null }));
  try {
    const result = await chapterSave(state.chapter, state.draft, baseVersion);
    // Our save's chapter.updated echo (matched by version when reported).
    suppressEchoFor = { chapter: state.chapter, version: result.version };
    chapterEditor.update((s) => ({
      ...s,
      saving: false,
      conflict: null,
      staleWarning: false,
      baseline: { content: s.draft, version: result.version ?? (baseVersion ?? 0) + 1 },
      lastSaved: { at: Date.now(), version: result.version },
    }));
    void refreshChapterList();
    return true;
  } catch (raw) {
    if (isChapterConflictError(raw)) {
      // The engine moved again while we reviewed: re-offer the resolution
      // against the newest revision.
      chapterEditor.update((s) => ({
        ...s,
        saving: false,
        conflict: {
          engineVersion: conflictCurrentVersion(raw),
          engineContent: null,
          reviewing: false,
          message: raw instanceof Error ? raw.message : 'chapter was modified concurrently again',
        },
      }));
      return false;
    }
    const structured = reportError(raw, 'chapter.save (overwrite)');
    chapterEditor.update((s) => ({ ...s, saving: false, error: structured }));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Unsaved-change guard (chapter switch / editor close / route navigation)
// ---------------------------------------------------------------------------

export type ChapterGuardAction =
  | { kind: 'navigate'; target: RouteId }
  | { kind: 'switch'; targetChapter: number }
  | { kind: 'close' }
  | { kind: 'stop-edit' };

/** Pending dirty-state decision; rendered by the shell as an explicit choice. */
export const chapterGuard: Writable<ChapterGuardAction | null> = writable(null);
/** Busy flag while "save & continue" runs. */
export const guardSaving: Writable<boolean> = writable(false);

function performGuardAction(action: ChapterGuardAction): void {
  if (action.kind === 'navigate') {
    proceedBlockedNavigation();
  } else if (action.kind === 'switch') {
    void loadChapter(action.targetChapter);
  } else if (action.kind === 'stop-edit') {
    // Keep the reader open; the draft was already reverted by the resolver.
    chapterEditor.update((s) => ({ ...s, conflict: null, staleWarning: false }));
  } else {
    resetEditor();
  }
}

/** Stay on the chapter; keep the dirty edits. */
export function guardStay(): void {
  chapterGuard.set(null);
  cancelBlockedNavigation();
}

/** Discard the edits (revert to the engine baseline), then proceed. */
export function guardDiscardAndProceed(): void {
  const action = get(chapterGuard);
  chapterGuard.set(null);
  const state = get(chapterEditor);
  if (state.baseline !== null) {
    chapterEditor.update((s) => ({ ...s, draft: s.baseline?.content ?? '', conflict: null, staleWarning: false }));
  } else {
    resetEditor();
  }
  if (action) performGuardAction(action);
}

/** Save first, then proceed; a failed save (e.g. conflict) keeps you here. */
export async function guardSaveAndProceed(): Promise<void> {
  const action = get(chapterGuard);
  if (!action) return;
  guardSaving.set(true);
  const ok = await saveEditor();
  guardSaving.set(false);
  if (!ok) {
    // Stay: the conflict/error is presented in the editor for resolution.
    chapterGuard.set(null);
    cancelBlockedNavigation();
    return;
  }
  chapterGuard.set(null);
  performGuardAction(action);
}

// ---------------------------------------------------------------------------
// Revisions: check (on demand + on entry) and sync (explicit confirmation)
// ---------------------------------------------------------------------------

export interface RevisionsCheckState {
  status: 'idle' | 'checking';
  changed: number[];
  checkedAt: number | null;
  error: StructuredError | null;
}

export const revisionCheck: Writable<RevisionsCheckState> = writable({
  status: 'idle',
  changed: [],
  checkedAt: null,
  error: null,
});

export async function runRevisionCheck(chapter?: number): Promise<void> {
  revisionCheck.update((s) => ({ ...s, status: 'checking', error: null }));
  try {
    const result = await chapterRevisionsCheck(chapter);
    revisionCheck.set({
      status: 'idle',
      changed: result.chapters ?? [],
      checkedAt: Date.now(),
      error: null,
    });
  } catch (raw) {
    const structured = reportError(raw, 'chapter.revisions.check');
    revisionCheck.update((s) => ({ ...s, status: 'idle', error: structured }));
  }
}

export interface RevisionSyncState {
  /** confirming: the explicit confirmation is showing; no request yet. */
  status: 'idle' | 'confirming' | 'syncing' | 'completed' | 'failed';
  /** Chapters the engine reported as changed (what sync will process). */
  scope: number[] | null;
  /** Single-chapter scope (payload chapter field), null = all changed. */
  chapter: number | null;
  applied: number[];
  startedAt: number | null;
  completedAt: number | null;
  message: string | null;
  error: StructuredError | null;
}

export const revisionSync: Writable<RevisionSyncState> = writable({
  status: 'idle',
  scope: null,
  chapter: null,
  applied: [],
  startedAt: null,
  completedAt: null,
  message: null,
  error: null,
});

/**
 * Ask for sync confirmation, stating exactly what will change. `chapter`
 * scopes the sync to one chapter; without it the engine syncs every changed
 * chapter (scope = the last check's changed list).
 */
export function requestRevisionSync(chapter?: number): void {
  const changed = get(revisionCheck).changed;
  revisionSync.set({
    status: 'confirming',
    scope: chapter === undefined ? changed : changed.includes(chapter) ? [chapter] : [],
    chapter: chapter ?? null,
    applied: [],
    startedAt: null,
    completedAt: null,
    message: null,
    error: null,
  });
}

/** Cancel the confirmation: no request is sent. */
export function cancelRevisionSync(): void {
  revisionSync.update((s) => (s.status === 'confirming' ? { ...s, status: 'idle' } : s));
}

/**
 * Confirm: issue chapter.revisions.sync. Acceptance means the engine took
 * the job; applied chapters arrive as chapter.updated {status:"synced"}
 * facts and the terminal notification (details.applied). Failures arrive as
 * engine.error events. There is no cancel-once-accepted in desktop-v1.
 */
export async function confirmRevisionSync(): Promise<boolean> {
  const state = get(revisionSync);
  if (state.status !== 'confirming') return false;
  revisionSync.update((s) => ({ ...s, status: 'syncing', startedAt: Date.now(), error: null }));
  try {
    const acceptance = await chapterRevisionsSync(state.chapter === null ? undefined : state.chapter);
    const appliedNow = Array.isArray(acceptance.applied) ? acceptance.applied : undefined;
    if (appliedNow) {
      // Synchronous no-op path (chapter filter found nothing to do).
      revisionSync.update((s) => ({
        ...s,
        status: 'completed',
        applied: appliedNow,
        completedAt: Date.now(),
        message: 'nothing to sync',
      }));
      return true;
    }
    // Accepted: expected set = the engine's changed list for this scope.
    const changed = acceptance.changed ?? state.scope ?? [];
    revisionSync.update((s) => ({ ...s, scope: changed }));
    if (changed.length === 0) {
      revisionSync.update((s) => ({
        ...s,
        status: 'completed',
        completedAt: Date.now(),
        message: 'nothing to sync',
      }));
    }
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'chapter.revisions.sync');
    revisionSync.update((s) => ({ ...s, status: 'failed', error: structured }));
    return false;
  }
}

/** Dismiss a completed/failed sync result. */
export function dismissRevisionSyncResult(): void {
  revisionSync.set({
    status: 'idle',
    scope: null,
    chapter: null,
    applied: [],
    startedAt: null,
    completedAt: null,
    message: null,
    error: null,
  });
}

// ---------------------------------------------------------------------------
// Engine-driven updates (observed facts only)
// ---------------------------------------------------------------------------

let lastFactId = 0;
let lastNotificationId = 0;

function noteSyncedFact(fact: ChapterUpdateFact): void {
  const state = get(revisionSync);
  if (state.status !== 'syncing') return;
  const applied = state.applied.includes(fact.chapter) ? state.applied : [...state.applied, fact.chapter];
  const expected = state.scope ?? [];
  const complete = expected.length > 0 && expected.every((ch) => applied.includes(ch));
  if (complete) {
    revisionSync.update((s) => ({ ...s, applied, status: 'completed', completedAt: Date.now() }));
    // Chapters changed under us: refresh the mismatch projection.
    void runRevisionCheck();
  } else {
    revisionSync.update((s) => ({ ...s, applied }));
  }
}

function noteNotification(level: string, message: string, details: unknown): void {
  const state = get(revisionSync);
  if (state.status !== 'syncing') return;
  const appliedFromDetails =
    typeof details === 'object' && details !== null && Array.isArray((details as { applied?: unknown }).applied)
      ? ((details as { applied: unknown[] }).applied).filter(
          (v): v is number => typeof v === 'number' && Number.isFinite(v),
        )
      : undefined;
  if (level === 'info' && appliedFromDetails) {
    // Engine terminal signal: "revision sync completed: N applied" carries
    // details.applied — matched structurally, never by message text.
    revisionSync.update((s) => ({
      ...s,
      status: 'completed',
      applied: appliedFromDetails.length > 0 ? appliedFromDetails : s.applied,
      completedAt: Date.now(),
      message: `sync completed — ${appliedFromDetails.length} applied`,
    }));
    void runRevisionCheck();
    return;
  }
  if (level === 'error') {
    // engine.error during the sync window is the documented failure channel
    // (a run cannot be active: the engine rejects sync with host_busy).
    revisionSync.update((s) => ({ ...s, status: 'failed', message }));
  }
}

// Subscriptions live for the module's lifetime (the stores are app-global).
chapterEvents.subscribe((facts) => {
  for (const fact of facts) {
    if (fact.id > lastFactId) {
      lastFactId = fact.id;
      if (fact.synced) noteSyncedFact(fact);
      noteEngineTouchedChapter(fact);
    }
  }
});

notifications.subscribe((all) => {
  for (const n of all) {
    if (n.id > lastNotificationId) {
      lastNotificationId = n.id;
      noteNotification(n.level, n.message, n.details);
    }
  }
});

/** The engine changed the open chapter (sync/run commit) under the editor. */
let suppressEchoFor: { chapter: number; version?: number } | null = null;

function noteEngineTouchedChapter(fact: ChapterUpdateFact): void {
  if (
    suppressEchoFor !== null &&
    suppressEchoFor.chapter === fact.chapter &&
    fact.status === 'saved' &&
    (suppressEchoFor.version === undefined || fact.version === undefined || fact.version === suppressEchoFor.version)
  ) {
    // The echo of our own successful save; the save flow already rebased.
    suppressEchoFor = null;
    return;
  }
  const state = get(chapterEditor);
  if (state.chapter !== fact.chapter) return;
  if (state.saving || state.loading) return;
  if (get(editorDirty)) {
    chapterEditor.update((s) => ({ ...s, staleWarning: true }));
  } else if (state.baseline !== null) {
    // Clean view: silently pick up the engine's newer text.
    void loadChapter(fact.chapter);
  }
}

// Navigation guard: armed when the Chapters screen first mounts (dirty edits
// can only originate there); registered lazily to avoid module-cycle TDZ
// (routes.ts imports the screens which import this module).
let guardArmed = false;

function chapterNavigationGuard(target: RouteId): boolean {
  if (!get(editorDirty)) return true;
  chapterGuard.set({ kind: 'navigate', target });
  return false;
}

function armNavigationGuard(): void {
  if (guardArmed) return;
  guardArmed = true;
  setNavigationGuard(chapterNavigationGuard);
}

// Project closed → drop editor/guard state (nothing to be dirty against).
projectSnapshot.subscribe((snapshot) => {
  if (snapshot === null) {
    chapterGuard.set(null);
    if (get(chapterEditor).chapter !== null || get(chapterListState).items.length > 0) {
      resetEditor();
      chapterListState.set({ items: [], loading: false, error: null });
      revisionCheck.set({ status: 'idle', changed: [], checkedAt: null, error: null });
      revisionSync.set({
        status: 'idle',
        scope: null,
        chapter: null,
        applied: [],
        startedAt: null,
        completedAt: null,
        message: null,
        error: null,
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Screen entry (ChaptersScreen mount)
// ---------------------------------------------------------------------------

function engineReady(): boolean {
  const connection = get(connectionState);
  return connection === 'ready' || connection === 'degraded';
}

/**
 * Chapters screen entry: refresh the list projection and run the revision
 * check (on entry, per contract). No-ops without a project/engine so the
 * empty state renders instead of error noise.
 */
export function enterChaptersScreen(): void {
  armNavigationGuard();
  if (get(projectSnapshot) === null || !engineReady()) return;
  void refreshChapterList();
  void runRevisionCheck();
}

/** Reset all module state (tests / disposal). */
export function resetChaptersState(): void {
  resetEditor();
  chapterListState.set({ items: [], loading: false, error: null });
  revisionCheck.set({ status: 'idle', changed: [], checkedAt: null, error: null });
  revisionSync.set({
    status: 'idle',
    scope: null,
    chapter: null,
    applied: [],
    startedAt: null,
    completedAt: null,
    message: null,
    error: null,
  });
  chapterGuard.set(null);
  guardSaving.set(false);
  lastFactId = 0;
  lastNotificationId = 0;
  suppressEchoFor = null;
}
