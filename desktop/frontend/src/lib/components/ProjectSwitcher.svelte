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
  {#if projectLabel}
    <span class="current-project" title={projectLabel}>
      <span class="project-dot" aria-hidden="true"></span>
      {projectLabel}
    </span>
    <button type="button" class="ghost" onclick={() => close()} disabled={busy} data-testid="close-project">
      Close
    </button>
  {:else}
    <span class="current-project none">No project open</span>
  {/if}

  <input
    type="text"
    class="path-input"
    placeholder={projectsDir ? `e.g. ${projectsDir}/My-Novel` : 'Absolute project directory…'}
    bind:value={path}
    onblur={revalidate}
    data-testid="project-path-input"
  />
  <button type="button" class="ghost" onclick={revalidate} disabled={!bridged || validating || path.trim() === ''}>
    {validating ? 'Checking…' : 'Check'}
  </button>
  <button
    type="button"
    class="primary"
    onclick={() => open()}
    disabled={!bridged || busy || validating || path.trim() === ''}
    data-testid="open-project"
  >
    Open
  </button>
  {#if report && !report.recognized}
    <button
      type="button"
      class="ghost"
      onclick={() => create()}
      disabled={!bridged || busy || validating}
      data-testid="create-project"
    >
      Create here
    </button>
  {/if}

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
    gap: 0.5rem;
    flex-wrap: wrap;
    min-width: 0;
  }
  .current-project {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-weight: 600;
    max-width: 18rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .current-project.none {
    color: var(--text-faint);
    font-weight: 400;
  }
  .project-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
  }
  .path-input {
    min-width: 16rem;
    flex: 1;
  }
  .validation-note {
    flex-basis: 100%;
    margin: 0;
    font-size: 0.78rem;
    color: var(--text-faint);
  }
</style>
