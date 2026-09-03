/**
 * Native dialog pickers (tauri-plugin-dialog). The frontend never touches
 * the filesystem: a picker returns a path STRING which callers forward
 * verbatim to `project.open` / `project.create` (or later `chapter.export`
 * / `diagnostics.export` destination fields). Cancellation resolves to
 * `null` and is never an error.
 *
 * Outside the Tauri webview the plugin is unavailable; callers should hide
 * picker affordances via `canUseNativeDialogs()` instead of invoking them.
 */

import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';

import { hasTauriBridge } from './desktop';

export function canUseNativeDialogs(): boolean {
  return hasTauriBridge();
}

/**
 * Pick an existing directory (project open / new-project parent folder).
 * Resolves with the chosen absolute path or null when cancelled.
 */
export async function pickDirectory(options: { title?: string; defaultPath?: string } = {}): Promise<string | null> {
  const picked = await openDialog({
    directory: true,
    multiple: false,
    title: options.title,
    defaultPath: options.defaultPath,
  });
  // single-selection `open` returns string | null.
  return typeof picked === 'string' ? picked : null;
}

/**
 * Pick an existing file (import / simulation sources, profile files).
 * Resolves with the chosen absolute path or null when cancelled.
 */
export async function pickFile(
  options: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> } = {},
): Promise<string | null> {
  const picked = await openDialog({
    directory: false,
    multiple: false,
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters,
  });
  // single-selection `open` returns string | null.
  return typeof picked === 'string' ? picked : null;
}

/**
 * Pick a save destination (export flows, later tasks). Resolves with the
 * chosen path or null when cancelled.
 */
export async function pickSaveTarget(
  options: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> } = {},
): Promise<string | null> {
  const picked = await saveDialog({
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters,
  });
  return typeof picked === 'string' ? picked : null;
}
