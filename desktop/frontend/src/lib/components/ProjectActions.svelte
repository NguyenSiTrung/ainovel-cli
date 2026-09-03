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
  <button type="button" class="primary" onclick={() => (showNewForm = !showNewForm)} disabled={!nativeDialogs || creating || opening} data-testid="project-action-new">
    New project…
  </button>
  <button type="button" onclick={() => open()} disabled={!nativeDialogs || opening || creating} data-testid="project-action-open">
    {opening ? 'Opening…' : 'Open…'}
  </button>
  {#if projectOpen}
    <button type="button" class="ghost" onclick={() => close()} disabled={closing || creating || opening} data-testid="project-action-close">
      {closing ? 'Closing…' : 'Close project'}
    </button>
  {/if}

  {#if showNewForm}
    <form class="new-project-form" data-testid="new-project-form" onsubmit={(event) => { event.preventDefault(); void create(); }}>
      <label>
        Project name
        <input
          type="text"
          placeholder="My Novel"
          bind:value={newName}
          data-testid="project-name-input"
        />
      </label>
      <label class="parent-label">
        Folder
        <button type="button" onclick={() => chooseParent()} disabled={pickingParent} data-testid="project-parent-pick">
          {pickingParent ? 'Choosing…' : parentDir ? 'Change folder…' : 'Choose folder…'}
        </button>
        {#if parentDir}
          <code class="parent-path" data-testid="project-parent-path">{parentDir}</code>
        {/if}
      </label>
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
    </form>
  {/if}

  {#if openReport && !openReport.recognized}
    <p class="open-note" data-testid="project-open-unrecognized">
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
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  .new-project-form {
    flex-basis: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: flex-end;
    padding: 0.6rem 0.75rem;
    border: 1px dashed var(--border);
    border-radius: 8px;
    background: var(--surface-2);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.78rem;
    color: var(--text-dim);
  }
  .parent-label {
    flex-direction: column;
  }
  .parent-path {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--text-faint);
    max-width: 22rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .busy {
    font-size: 0.78rem;
    color: var(--text-faint);
  }
  .open-note {
    flex-basis: 100%;
    margin: 0;
    font-size: 0.78rem;
    color: var(--text-faint);
  }
</style>
