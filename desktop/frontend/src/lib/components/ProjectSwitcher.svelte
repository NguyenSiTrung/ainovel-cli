<script lang="ts">
  /**
   * Project selection. Paths are validated through the shell
   * (`desktop_validate_project_dir`) and opened through the engine
   * (`project.open` / `project.create`) — the frontend never touches the
   * filesystem itself. `recognized` is a hint; the engine stays the
   * authority on project validity.
   */
  import { onMount } from 'svelte';

  import { getPaths, hasTauriBridge, validateProjectDir } from '$lib/api/desktop';
  import {
    closeProject,
    connectionState,
    createProject,
    openProject,
    projectSnapshot,
    reportError,
  } from '$lib/stores/desktop';
  import { presentError, type ProjectDirReport } from '$lib/types/protocol';

  let path = $state('');
  let report: ProjectDirReport | null = $state(null);
  let validating = $state(false);
  let validationMessage = $state<string | null>(null);
  let projectsDir = $state<string | null>(null);
  let busy = $state(false);

  let snapshot = $derived($projectSnapshot);
  let projectLabel = $derived(snapshot?.book_title ?? snapshot?.status_label ?? null);
  const bridged = hasTauriBridge();
  let connection = $derived($connectionState);
  let engineFailed = $derived(connection === 'failed');


  onMount(() => {
    if (!bridged) return;
    getPaths()
      .then((paths) => {
        projectsDir = paths.projectsDir;
      })
      .catch(() => {
        // Path defaults are cosmetic; ignore failures.
      });
  });

  async function revalidate(): Promise<void> {
    if (!bridged || path.trim() === '') {
      report = null;
      validationMessage = null;
      return;
    }
    validating = true;
    validationMessage = null;
    try {
      report = await validateProjectDir(path.trim());
      if (!report.recognized) {
        validationMessage = 'Directory exists but has no project marker — Open will let the engine decide, or Create initializes it.';
      }
    } catch (raw) {
      report = null;
      const structured = reportError(raw, 'validate path');
      validationMessage = presentError(structured.code).title;
    } finally {
      validating = false;
    }
  }

  async function open(): Promise<void> {
    if (path.trim() === '' || busy) return;
    if (engineFailed) {
      reportError({ code: 'engine_unavailable', message: 'Engine is unavailable' }, 'project.open');
      return;
    }
    busy = true;
    try {
      await openProject(path.trim());
    } catch (raw) {
      reportError(raw, 'project.open');
    } finally {
      busy = false;
    }
  }

  async function create(): Promise<void> {
    if (path.trim() === '' || busy) return;
    if (engineFailed) {
      reportError({ code: 'engine_unavailable', message: 'Engine is unavailable' }, 'project.create');
      return;
    }
    busy = true;
    try {
      await createProject(path.trim());
    } catch (raw) {
      reportError(raw, 'project.create');
    } finally {
      busy = false;
    }
  }

  async function close(): Promise<void> {
    busy = true;
    try {
      await closeProject();
    } catch (raw) {
      reportError(raw, 'project.close');
    } finally {
      busy = false;
    }
  }
</script>

<div class="project-switcher" data-testid="project-switcher">
  <div class="project-badge-container">
    {#if projectLabel}
      <div class="project-pill active" title={projectLabel}>
        <svg class="book-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
          <path d="M6 6h10" />
        </svg>
        <span class="current-project" title={projectLabel} data-testid="current-project">
          <span class="project-dot" aria-hidden="true"></span>
          <span class="project-title-text">{projectLabel}</span>
        </span>
        <button type="button" class="close-btn ghost" onclick={() => close()} disabled={busy} data-testid="close-project" title="Close current project">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          Close
        </button>
      </div>
    {:else}
      <div class="project-pill none">
        <svg class="book-icon faint" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
        </svg>
        <span class="current-project none">No project open</span>
      </div>
    {/if}
  </div>

  <div class="path-controls-group">
    <div class="input-wrapper">
      <svg class="input-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      </svg>
      <input
        type="text"
        class="path-input"
        placeholder={projectsDir ? `e.g. ${projectsDir}/My-Novel` : 'Absolute project directory…'}
        bind:value={path}
        onblur={revalidate}
        data-testid="project-path-input"
      />
    </div>
    <button type="button" class="ghost" onclick={revalidate} disabled={!bridged || validating || path.trim() === ''}>
      {validating ? 'Checking…' : 'Check'}
    </button>
    <button
      type="button"
      class="primary"
      onclick={() => open()}
      disabled={!bridged || busy || validating || engineFailed || path.trim() === ''}
      title={engineFailed ? 'Engine is unavailable' : undefined}
      data-testid="open-project"
    >
      Open
    </button>
    {#if report && !report.recognized}
      <button
        type="button"
        class="ghost"
        onclick={() => create()}
        disabled={!bridged || busy || validating || engineFailed}
        title={engineFailed ? 'Engine is unavailable' : undefined}
        data-testid="create-project"
      >
        Create here
      </button>
    {/if}
  </div>

  {#if validationMessage}
    <p class="validation-note" data-testid="validation-note">{validationMessage}</p>
  {/if}
  {#if !bridged}
    <p class="validation-note">Engine actions require the desktop shell (tauri dev / built app).</p>
  {/if}
</div>

<style>
  .project-switcher {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    flex-wrap: wrap;
    min-width: 0;
  }
  .project-badge-container {
    display: flex;
    align-items: center;
  }
  .project-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.2rem 0.6rem;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    background: var(--surface-2);
    font-size: 0.82rem;
  }
  .project-pill.active {
    border-color: color-mix(in srgb, var(--accent) 35%, transparent);
    background: color-mix(in srgb, var(--accent) 8%, var(--surface-2));
  }
  .book-icon {
    color: var(--accent);
    flex-shrink: 0;
  }
  .book-icon.faint {
    color: var(--text-faint);
  }
  .current-project {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-weight: 600;
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .current-project.none {
    color: var(--text-faint);
    font-weight: 400;
  }
  .project-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 6px var(--ok);
    flex-shrink: 0;
  }
  .project-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .close-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.1rem 0.35rem;
    font-size: 0.72rem;
    color: var(--text-dim);
    border-radius: var(--radius-xs);
    margin-left: 0.2rem;
  }
  .close-btn:hover {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 15%, transparent);
  }
  .path-controls-group {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex: 1;
    min-width: 16rem;
  }
  .input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
    flex: 1;
  }
  .input-icon {
    position: absolute;
    left: 0.55rem;
    color: var(--text-faint);
    pointer-events: none;
  }
  .path-input {
    padding-left: 1.8rem;
    width: 100%;
    font-size: 0.8rem;
    height: 1.85rem;
    background: var(--surface-2);
  }
  .validation-note {
    flex-basis: 100%;
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-dim);
  }
</style>
