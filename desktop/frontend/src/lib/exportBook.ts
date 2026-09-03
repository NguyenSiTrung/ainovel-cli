/**
 * Book/chapter export orchestration for the task-6 Export screen.
 *
 * Contract (task-2 daemon mapping + protocols/desktop-v1):
 * - `chapter.export {chapters?, format, output_path}` is SYNCHRONOUS local
 *   IO through the engine (no filesystem access from the frontend); the
 *   destination comes from the native save dialog as a path string,
 *   forwarded verbatim. A cancelled picker resolves null and sends nothing.
 * - `format` is txt or epub; omitting `chapters` exports the whole book;
 *   a chapters list is folded engine-side into a closed min..max range.
 * - The result carries {path, chapters, bytes, skipped}; failures are
 *   structured (operation_failed for IO/engine errors, invalid_payload for
 *   unsupported formats).
 */

import { get, writable, type Writable } from 'svelte/store';

import { pickSaveTarget } from '$lib/api/dialogs';
import { chapterExport, type ExportFormat } from '$lib/api/desktop';

export type { ExportFormat };
import { projectSnapshot, reportError } from '$lib/stores/desktop';
import type { StructuredError } from '$lib/types/protocol';

export const EXPORT_FILTERS: Record<ExportFormat, Array<{ name: string; extensions: string[] }>> = {
  txt: [{ name: 'Plain text', extensions: ['txt'] }],
  epub: [{ name: 'EPUB', extensions: ['epub'] }],
};

export type ExportScopeMode = 'book' | 'range';

export interface ExportState {
  status: 'idle' | 'picking' | 'exporting';
  /** Last completed export (kept until the next one starts). */
  result: {
    path?: string;
    chapters?: number;
    bytes?: number;
    skipped?: number[];
    format: ExportFormat;
    at: number;
  } | null;
  error: StructuredError | null;
}

export const exportState: Writable<ExportState> = writable({ status: 'idle', result: null, error: null });

export interface ExportRequest {
  mode: ExportScopeMode;
  format: ExportFormat;
  from: number;
  to: number;
}

/** Chapters array for a range (inclusive). The engine folds min..max anyway. */
export function chaptersForRange(from: number, to: number): number[] {
  const lo = Math.max(1, Math.min(from, to));
  const hi = Math.max(from, to);
  const out: number[] = [];
  for (let n = lo; n <= hi && out.length < 500; n += 1) out.push(n);
  return out;
}

function defaultFileName(format: ExportFormat, bookTitle: string | undefined): string {
  const base = (bookTitle ?? 'novel').trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
  return `${base === '' ? 'novel' : base}.${format}`;
}

/**
 * Run one export: native destination picker, then the synchronous
 * chapter.export request. A cancelled picker is not an error — the flow
 * simply returns to idle with no request sent.
 */
export async function runExport(request: ExportRequest): Promise<boolean> {
  if (get(exportState).status !== 'idle') return false;
  const snapshot = get(projectSnapshot);
  exportState.set({ status: 'picking', result: null, error: null });
  let destination: string | null;
  try {
    destination = await pickSaveTarget({
      title: request.mode === 'book' ? 'Export the whole book' : `Export chapters ${request.from}–${request.to}`,
      defaultPath: defaultFileName(request.format, snapshot?.book_title),
      filters: EXPORT_FILTERS[request.format],
    });
  } catch (raw) {
    // Picker failure (bridge trouble): surface, back to idle.
    const structured = reportError(raw, 'export destination');
    exportState.set({ status: 'idle', result: null, error: structured });
    return false;
  }
  if (destination === null) {
    exportState.set({ status: 'idle', result: null, error: null });
    return false;
  }

  exportState.set({ status: 'exporting', result: null, error: null });
  try {
    const chapters = request.mode === 'book' ? undefined : chaptersForRange(request.from, request.to);
    const result = await chapterExport(destination, request.format, chapters);
    exportState.set({
      status: 'idle',
      result: {
        path: result.path ?? destination,
        chapters: result.chapters,
        bytes: result.bytes,
        skipped: result.skipped,
        format: request.format,
        at: Date.now(),
      },
      error: null,
    });
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'chapter.export');
    exportState.set({ status: 'idle', result: null, error: structured });
    return false;
  }
}

/** Dismiss the last result/error. */
export function dismissExportResult(): void {
  exportState.set({ status: 'idle', result: null, error: null });
}

/** Format bytes for display. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
