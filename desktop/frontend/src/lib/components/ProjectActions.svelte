<script lang="ts">
  /**
   * Project lifecycle controls: create (name + native parent-directory
   * picker), open (native directory picker + shell validation), close.
   *
   * The native dialog returns a path STRING only; it is forwarded verbatim
   * to project.create / project.open through the engine. No filesystem
   * access happens in the webview. Loading and error states come from the
   * open/create commands themselves.
   */
  import { canUseNativeDialogs, pickDirectory } from '$lib/api/dialogs';
  import { validateProjectDir } from '$lib/api/desktop';
  import {
    closeProject,
    connectionState,
    createProject,
    openProject,
    projectSnapshot,
    pushNotification,
    reportError,
  } from '$lib/stores/desktop';
  import type { ProjectDirReport } from '$lib/types/protocol';

  let snapshot = $derived($projectSnapshot);

  let showNewForm = $state(false);
  let newName = $state('');
  let parentDir = $state<string | null>(null);
  let pickingParent = $state(false);
  let creating = $state(false);

  let opening = $state(false);
  let openReport: ProjectDirReport | null = $state(null);
  let closing = $state(false);

  let nativeDialogs = canUseNativeDialogs();
  let projectOpen = $derived(snapshot !== null);
  let connection = $derived($connectionState);
  let engineFailed = $derived(connection === 'failed');


  async function chooseParent(): Promise<void> {
    pickingParent = true;
    try {
      const picked = await pickDirectory({ title: 'Choose a folder for the new project' });
      if (picked !== null) parentDir = picked;
    } catch (raw) {
      reportError(raw, 'directory picker');
    } finally {
      pickingParent = false;
    }
  }

  async function create(): Promise<void> {
    if (engineFailed) {
      pushNotification('error', 'Novel engine is not ready — start or restart engine from the header bar.', {
        source: 'status',
      });
      return;
    }
    const name = newName.trim();
    if (parentDir === null || name === '' || creating) return;
    const path = joinPath(parentDir, name);
    creating = true;
    try {
      await createProject(path, name);
      showNewForm = false;
      newName = '';
      parentDir = null;
      pushNotification('info', `project created: ${path}`, { source: 'status' });
    } catch (raw) {
      reportError(raw, 'project.create');
    } finally {
      creating = false;
    }
  }

  async function open(): Promise<void> {
    if (opening) return;
    if (engineFailed) {
      pushNotification('error', 'Novel engine is not ready — start or restart engine from the header bar.', {
        source: 'status',
      });
      return;
    }
    let path: string | null = null;
    try {
      path = await pickDirectory({ title: 'Choose a project folder' });
    } catch (raw) {
      reportError(raw, 'directory picker');
      return;
    }
    if (path === null) return; // cancelled

    opening = true;
    openReport = null;
    try {
      // Native-side validation hint; the engine stays the authority.
      openReport = await validateProjectDir(path);
      if (!openReport.recognized) {
        pushNotification('warning', 'folder has no project marker — asking the engine to open it anyway', {
          source: 'status',
        });
      }
      await openProject(path);
    } catch (raw) {
      reportError(raw, 'project.open');
    } finally {
      opening = false;
    }
  }

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    try {
      await closeProject();
    } catch (raw) {
      reportError(raw, 'project.close');
    } finally {
      closing = false;
    }
  }

  function joinPath(parent: string, name: string): string {
    const trimmed = parent.replace(/[/\\]+$/, '');
    return `${trimmed}/${name}`;
  }
</script>

<div class="project-actions" data-testid="project-actions">
  <div class="actions-toolbar">
    <button
      type="button"
      class="primary action-btn"
      onclick={() => (showNewForm = !showNewForm)}
      disabled={!nativeDialogs || engineFailed || creating || opening}
      title={engineFailed ? 'Engine is unavailable' : undefined}
      data-testid="project-action-new"
    >New project…</button>
    <button
      type="button"
      class="action-btn"
      onclick={() => open()}
      disabled={!nativeDialogs || engineFailed || opening || creating}
      title={engineFailed ? 'Engine is unavailable' : undefined}
      data-testid="project-action-open"
    >{opening ? 'Opening…' : 'Open…'}</button>
    {#if projectOpen}
      <button
        type="button"
        class="ghost danger action-btn"
        onclick={() => close()}
        disabled={closing || creating || opening}
        data-testid="project-action-close"
      >{closing ? 'Closing…' : 'Close project'}</button>
    {/if}
  </div>

  {#if showNewForm}
    <form class="new-project-form" data-testid="new-project-form" onsubmit={(event) => { event.preventDefault(); void create(); }}>
      <div class="form-title-row">
        <span class="form-heading">Create New Novel Project</span>
        <button type="button" class="ghost small close-form-btn" onclick={() => (showNewForm = false)}>Cancel</button>
      </div>
      <div class="form-fields">
        <label>
          <span class="field-title">Project name</span>
          <input
            type="text"
            placeholder="e.g. The Chronicles of Solitude"
            bind:value={newName}
            data-testid="project-name-input"
          />
        </label>
        <label class="parent-label">
          <span class="field-title">Destination folder</span>
          <div class="parent-picker-row">
            <button type="button" class="picker-btn" onclick={() => chooseParent()} disabled={pickingParent} data-testid="project-parent-pick">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
              {pickingParent ? 'Choosing…' : parentDir ? 'Change folder…' : 'Choose folder…'}
            </button>
            {#if parentDir}
              <code class="parent-path" data-testid="project-parent-path">{parentDir}</code>
            {/if}
          </div>
        </label>
      </div>
      <div class="form-actions">
        <button
          type="submit"
          class="primary"
          disabled={creating || parentDir === null || newName.trim() === ''}
          data-testid="project-create-confirm"
        >
          {creating ? 'Creating…' : 'Create project'}
        </button>
        {#if creating}
          <span class="busy" data-testid="project-create-busy">creating project via engine…</span>
        {/if}
      </div>
    </form>
  {/if}

  {#if openReport && !openReport.recognized}
    <p class="open-note warning" data-testid="project-open-unrecognized">
      {openReport.path} has no project marker — the engine decides whether it can be opened.
    </p>
  {/if}
  {#if !nativeDialogs}
    <p class="open-note">Native pickers need the desktop shell (tauri dev / built app).</p>
  {/if}
</div>

<style>
  .project-actions {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 100%;
  }
  .actions-toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .action-btn {
    padding: 0.4rem 0.85rem;
    font-size: 0.85rem;
  }
  .new-project-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.9rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2);
    box-shadow: var(--shadow-sm);
  }
  .form-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border-subtle);
    padding-bottom: 0.4rem;
  }
  .form-heading {
    font-size: 0.86rem;
    font-weight: 600;
    color: var(--text);
  }
  .form-fields {
    display: flex;
    flex-wrap: wrap;
    gap: 0.85rem;
    align-items: flex-start;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.78rem;
    color: var(--text-dim);
    flex: 1;
    min-width: 14rem;
  }
  .field-title {
    font-weight: 500;
  }
  .parent-picker-row {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
  }
  .picker-btn {
    background: var(--surface-3);
  }
  .parent-path {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--text-dim);
    background: var(--surface-1);
    padding: 0.2rem 0.45rem;
    border-radius: var(--radius-xs);
    max-width: 20rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid var(--border-subtle);
  }
  .form-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding-top: 0.2rem;
  }
  .busy {
    font-size: 0.78rem;
    color: var(--accent);
    font-style: italic;
  }
  .open-note {
    margin: 0;
    font-size: 0.78rem;
    color: var(--text-faint);
  }
  .open-note.warning {
    color: var(--warn);
    padding: 0.35rem 0.6rem;
    background: var(--warn-subtle);
    border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
    border-radius: var(--radius-sm);
  }
</style>
