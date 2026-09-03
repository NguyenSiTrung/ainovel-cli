/**
 * Artifacts read-model for the task-6 Artifacts screen: the facts / world /
 * summaries projections served by `artifacts.read` (desktop-v1 README §12).
 * Mirrors `chapters.ts`: a passive projection plus one read request per
 * kind — no mutation exists (the engine owns artifact writes).
 *
 * Freshness: while the screen is active, every successful snapshot refresh
 * re-reads the three projections. The snapshot store is refreshed on resync
 * and on chapter/artifact/outline update signals (stores own that), so the
 * engine's own update signals drive these panes exactly like the outline.
 * `project_unavailable` clears silently (nothing to show, not an error).
 */

import { get, writable, type Writable } from 'svelte/store';

import {
  readFacts,
  readSummaries,
  readWorld,
  type ChapterFactsEntry,
  type ChapterSummaryEntry,
  type WorldRule,
} from '$lib/api/desktop';
import { connectionState, projectSnapshot, reportError } from '$lib/stores/desktop';
import type { StructuredError } from '$lib/types/protocol';

export interface ArtifactsPaneState<T> {
  entries: T[];
  loading: boolean;
  /** True once at least one read for this kind has resolved successfully. */
  loaded: boolean;
  error: StructuredError | null;
}

export interface ArtifactsState {
  facts: ArtifactsPaneState<ChapterFactsEntry>;
  world: ArtifactsPaneState<WorldRule>;
  summaries: ArtifactsPaneState<ChapterSummaryEntry>;
}

function emptyPane<T>(): ArtifactsPaneState<T> {
  return { entries: [], loading: false, loaded: false, error: null };
}

export const artifactsState: Writable<ArtifactsState> = writable({
  facts: emptyPane(),
  world: emptyPane(),
  summaries: emptyPane(),
});

/**
 * Read all three projections in parallel. Each kind settles independently:
 * one failing read never blanks its siblings, and a failed kind keeps its
 * last data with the error attached (the next refresh clears it).
 */
export async function refreshArtifacts(): Promise<void> {
  artifactsState.update((s) => ({
    facts: { ...s.facts, loading: true },
    world: { ...s.world, loading: true },
    summaries: { ...s.summaries, loading: true },
  }));
  const [facts, world, summaries] = await Promise.all([
    readFacts().then(
      (r) => ({ ok: true as const, entries: r.facts ?? [] }),
      (raw) => ({ ok: false as const, raw }),
    ),
    readWorld().then(
      (r) => ({ ok: true as const, entries: r.rules ?? [] }),
      (raw) => ({ ok: false as const, raw }),
    ),
    readSummaries().then(
      (r) => ({ ok: true as const, entries: r.summaries ?? [] }),
      (raw) => ({ ok: false as const, raw }),
    ),
  ]);
  artifactsState.update((s) => ({
    facts: settlePane(s.facts, facts),
    world: settlePane(s.world, world),
    summaries: settlePane(s.summaries, summaries),
  }));
}

function settlePane<T>(
  pane: ArtifactsPaneState<T>,
  outcome: { ok: true; entries: T[] } | { ok: false; raw: unknown },
): ArtifactsPaneState<T> {
  if (outcome.ok) {
    return { entries: outcome.entries, loading: false, loaded: true, error: null };
  }
  const structured = reportError(outcome.raw, 'artifacts.read');
  // No project open: nothing to show, not an error (mirrors chapter.list).
  if (structured.code === 'project_unavailable') {
    return { entries: [], loading: false, loaded: true, error: null };
  }
  return { ...pane, loading: false, error: structured };
}

// ---------------------------------------------------------------------------
// Screen lifecycle (ArtifactsScreen mount) + engine-driven refresh
// ---------------------------------------------------------------------------

let screenActive = false;

function engineReady(): boolean {
  const connection = get(connectionState);
  return connection === 'ready' || connection === 'degraded';
}

/**
 * Artifacts screen entry: read all three projections when there is something
 * to read. No-ops without a project/engine so the empty state renders
 * instead of error noise.
 */
export function enterArtifactsScreen(): void {
  screenActive = true;
  if (get(projectSnapshot) === null || !engineReady()) return;
  void refreshArtifacts();
}

/** Screen exit: snapshot-driven refreshes stop (no requests for hidden panes). */
export function leaveArtifactsScreen(): void {
  screenActive = false;
}

// Snapshot transitions drive the read model while the screen is mounted:
// null → project closed (reset); a fresh snapshot → the engine's update
// signals (chapter/artifact/outline) or a resync just landed → re-read.
projectSnapshot.subscribe((snapshot) => {
  if (snapshot === null) {
    artifactsState.set({ facts: emptyPane(), world: emptyPane(), summaries: emptyPane() });
    return;
  }
  if (screenActive) void refreshArtifacts();
});

/** Reset all module state (tests / disposal). */
export function resetArtifactsState(): void {
  artifactsState.set({ facts: emptyPane(), world: emptyPane(), summaries: emptyPane() });
}
