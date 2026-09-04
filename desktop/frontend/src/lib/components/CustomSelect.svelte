<script lang="ts">

  export interface OptionItem {
    value: string;
    label?: string;
    badge?: string;
    description?: string;
    disabled?: boolean;
  }

  type SelectOption = OptionItem | string;

  let {
    value = $bindable(''),
    options = [],
    placeholder = 'Select…',
    disabled = false,
    dataTestId,
    id,
    name,
    searchable = undefined,
    searchPlaceholder = 'Search…',
    mono = false,
    class: className = '',
    onchange,
  }: {
    value?: string;
    options: SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    dataTestId?: string;
    id?: string;
    name?: string;
    searchable?: boolean;
    searchPlaceholder?: string;
    mono?: boolean;
    class?: string;
    onchange?: (event: Event) => void;
  } = $props();

  let isOpen = $state(false);
  let searchQuery = $state('');
  let highlightedIndex = $state(-1);
  let containerEl = $state<HTMLElement | null>(null);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let nativeSelectEl = $state<HTMLSelectElement | null>(null);
  let searchInputEl = $state<HTMLInputElement | null>(null);
  let optionsListEl = $state<HTMLElement | null>(null);

  // Normalize options to OptionItem objects
  let normalizedOptions = $derived<OptionItem[]>(
    options.map((opt) =>
      typeof opt === 'string'
        ? { value: opt, label: opt }
        : {
            value: opt.value,
            label: opt.label ?? opt.value,
            badge: opt.badge,
            description: opt.description,
            disabled: opt.disabled,
          },
    ),
  );

  // Determine if search should be enabled (auto-enabled if > 5 options unless explicitly set)
  let isSearchEnabled = $derived(
    searchable !== undefined ? searchable : normalizedOptions.length > 5,
  );

  // Filter options based on search query
  let filteredOptions = $derived.by(() => {
    if (!searchQuery.trim()) return normalizedOptions;
    const q = searchQuery.toLowerCase().trim();
    return normalizedOptions.filter(
      (opt) =>
        opt.label?.toLowerCase().includes(q) ||
        opt.value.toLowerCase().includes(q) ||
        opt.description?.toLowerCase().includes(q),
    );
  });

  // Currently selected option
  let selectedOption = $derived(normalizedOptions.find((opt) => opt.value === value));
  let displayLabel = $derived(selectedOption?.label ?? (value || placeholder));

  // Sync with native select when custom selection occurs
  function selectOption(optVal: string) {
    if (optVal === value && isOpen) {
      isOpen = false;
      searchQuery = '';
      return;
    }
    value = optVal;
    isOpen = false;
    searchQuery = '';
    if (nativeSelectEl) {
      nativeSelectEl.value = optVal;
      const evt = new Event('change', { bubbles: true });
      nativeSelectEl.dispatchEvent(evt);
    }
  }

  // Handle programmatic or test events directly on the native select
  function handleNativeChange(e: Event) {
    const target = e.currentTarget as HTMLSelectElement;
    value = target.value;
    onchange?.(e);
  }

  function toggleDropdown() {
    if (disabled) return;
    isOpen = !isOpen;
    if (isOpen) {
      searchQuery = '';
      highlightedIndex = Math.max(
        0,
        filteredOptions.findIndex((opt) => opt.value === value),
      );
    }
  }

  function handleTriggerKeydown(e: KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      isOpen = true;
      highlightedIndex = Math.max(
        0,
        filteredOptions.findIndex((opt) => opt.value === value),
      );
    }
  }

  function handleDropdownKeydown(e: KeyboardEvent) {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      isOpen = false;
      triggerEl?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filteredOptions.length > 0) {
        highlightedIndex = (highlightedIndex + 1) % filteredOptions.length;
        scrollHighlightedIntoView();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filteredOptions.length > 0) {
        highlightedIndex = (highlightedIndex - 1 + filteredOptions.length) % filteredOptions.length;
        scrollHighlightedIntoView();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = filteredOptions[highlightedIndex];
      if (chosen && !chosen.disabled) {
        selectOption(chosen.value);
        triggerEl?.focus();
      }
    } else if (e.key === 'Tab') {
      isOpen = false;
    }
  }

  function scrollHighlightedIntoView() {
    if (!optionsListEl) return;
    const items = optionsListEl.querySelectorAll('.select-option');
    const target = items[highlightedIndex] as HTMLElement | undefined;
    if (target) {
      target.scrollIntoView({ block: 'nearest' });
    }
  }

  // Close dropdown on outside click
  $effect(() => {
    if (isOpen) {
      const onPointerDown = (e: PointerEvent) => {
        if (containerEl && !containerEl.contains(e.target as Node)) {
          isOpen = false;
          searchQuery = '';
        }
      };
      window.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('keydown', handleDropdownKeydown);
      return () => {
        window.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('keydown', handleDropdownKeydown);
      };
    }
  });

  // Focus search input when opened
  $effect(() => {
    if (isOpen && searchInputEl) {
      searchInputEl.focus();
    }
  });
</script>

<div
  class="custom-select-container {className}"
  class:disabled
  class:open={isOpen}
  bind:this={containerEl}
>
  <!-- Visually hidden native select to guarantee 100% test and accessibility compatibility -->
  <select
    bind:this={nativeSelectEl}
    class="visually-hidden-select"
    tabindex="-1"
    aria-hidden="true"
    value={value}
    onchange={handleNativeChange}
    data-testid={dataTestId}
    {disabled}
    {id}
    {name}
  >
    {#if placeholder && !value}
      <option value="" disabled selected>{placeholder}</option>
    {/if}
    {#each normalizedOptions as opt (opt.value)}
      <option value={opt.value} disabled={opt.disabled}>{opt.label}</option>
    {/each}
  </select>

  <!-- Polished visual trigger button -->
  <button
    type="button"
    class="select-trigger"
    class:mono
    class:has-selection={!!value}
    bind:this={triggerEl}
    onclick={toggleDropdown}
    onkeydown={handleTriggerKeydown}
    aria-haspopup="listbox"
    aria-expanded={isOpen}
    {disabled}
  >
    <span class="trigger-label-group">
      <span class="trigger-text" class:placeholder-text={!value}>
        {displayLabel}
      </span>
      {#if selectedOption?.badge}
        <span class="option-badge trigger-badge">{selectedOption.badge}</span>
      {/if}
    </span>
    <span class="chevron-wrapper" class:rotated={isOpen} aria-hidden="true">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </span>
  </button>

  <!-- Modern dark obsidian floating dropdown panel -->
  {#if isOpen}
    <div class="select-dropdown" role="listbox">
      {#if isSearchEnabled}
        <div class="search-box">
          <svg
            class="search-icon"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            type="text"
            class="search-input"
            bind:this={searchInputEl}
            bind:value={searchQuery}
            placeholder={searchPlaceholder}
            onkeydown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
                e.stopPropagation();
                handleDropdownKeydown(e);
              }
            }}
          />
          {#if searchQuery}
            <button
              type="button"
              class="clear-search-btn"
              onclick={() => {
                searchQuery = '';
                searchInputEl?.focus();
              }}
              aria-label="Clear search"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          {/if}
        </div>
      {/if}

      <div class="options-list" bind:this={optionsListEl}>
        {#if filteredOptions.length === 0}
          <div class="empty-options">No matching options</div>
        {:else}
          {#each filteredOptions as opt, idx (opt.value)}
            {@const isSelected = opt.value === value}
            {@const isHighlighted = idx === highlightedIndex}
            <button
              type="button"
              role="option"
              aria-selected={isSelected}
              class="select-option"
              class:selected={isSelected}
              class:highlighted={isHighlighted}
              class:mono
              disabled={opt.disabled}
              onclick={() => selectOption(opt.value)}
              onmouseenter={() => (highlightedIndex = idx)}
            >
              <div class="option-content">
                <span class="option-label">{opt.label}</span>
                {#if opt.description}
                  <span class="option-description">{opt.description}</span>
                {/if}
              </div>

              <div class="option-extras">
                {#if opt.badge}
                  <span class="option-badge">{opt.badge}</span>
                {/if}
                {#if isSelected}
                  <svg
                    class="check-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                {/if}
              </div>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .custom-select-container {
    position: relative;
    width: 100%;
    min-width: 0;
  }

  /* Visually hidden native select kept for programmatic test & a11y compatibility */
  .visually-hidden-select {
    position: absolute !important;
    width: 1px !important;
    height: 1px !important;
    padding: 0 !important;
    margin: -1px !important;
    overflow: hidden !important;
    clip: rect(0, 0, 0, 0) !important;
    white-space: nowrap !important;
    border: 0 !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }

  .select-trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    width: 100%;
    min-height: 2.65rem;
    padding: 0.55rem 0.85rem;
    background: var(--surface-1);
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 0.87rem;
    font-weight: 550;
    line-height: 1.3;
    text-align: left;
    cursor: pointer;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
    transition:
      border-color var(--transition-fast),
      background var(--transition-fast),
      box-shadow var(--transition-fast),
      transform var(--transition-fast);
    user-select: none;
  }

  .select-trigger.mono .trigger-text {
    font-family: var(--mono);
    font-size: 0.82rem;
    letter-spacing: -0.01em;
  }

  .select-trigger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--surface-1) 85%, var(--surface-2));
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border-hover));
  }

  .custom-select-container.open .select-trigger {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--surface-1) 90%, var(--accent));
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }

  .select-trigger:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }

  .select-trigger:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    background: var(--surface-2);
  }

  .trigger-label-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    overflow: hidden;
  }

  .trigger-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }

  .trigger-text.placeholder-text {
    color: var(--text-faint);
    font-weight: 400;
  }

  .chevron-wrapper {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    color: var(--text-dim);
    transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1), color var(--transition-fast);
  }

  .chevron-wrapper.rotated {
    transform: rotate(180deg);
    color: var(--accent);
  }

  /* Floating Dropdown Panel */
  .select-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 120;
    display: flex;
    flex-direction: column;
    background: var(--surface-elevated);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-hover));
    border-radius: var(--radius-md);
    box-shadow:
      0 12px 30px rgba(0, 0, 0, 0.55),
      0 3px 8px rgba(0, 0, 0, 0.35),
      0 0 0 1px rgba(255, 255, 255, 0.05);
    backdrop-filter: blur(12px);
    overflow: hidden;
    animation: dropdownFadeIn 120ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes dropdownFadeIn {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .search-box {
    position: relative;
    display: flex;
    align-items: center;
    padding: 0.45rem 0.6rem;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface-0) 65%, var(--surface-1));
  }

  .search-icon {
    position: absolute;
    left: 0.95rem;
    color: var(--text-faint);
    pointer-events: none;
  }

  .search-input {
    width: 100%;
    height: 1.95rem;
    padding: 0.2rem 1.6rem 0.2rem 1.75rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    color: var(--text);
    font-size: 0.8rem;
    outline: none;
    transition: border-color var(--transition-fast);
  }

  .search-input:focus {
    border-color: var(--accent);
    background: var(--surface-1);
  }

  .clear-search-btn {
    position: absolute;
    right: 0.85rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.1rem;
    height: 1.1rem;
    padding: 0;
    color: var(--text-dim);
    background: var(--surface-3);
    border: none;
    border-radius: var(--radius-full);
    cursor: pointer;
  }

  .clear-search-btn:hover {
    color: var(--text);
    background: var(--border-hover);
  }

  .options-list {
    max-height: 230px;
    overflow-y: auto;
    padding: 0.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .empty-options {
    padding: 1.25rem 0.85rem;
    color: var(--text-faint);
    font-size: 0.82rem;
    text-align: center;
  }

  .select-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    width: 100%;
    padding: 0.5rem 0.65rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-xs);
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: 0.84rem;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition:
      background var(--transition-fast),
      color var(--transition-fast),
      border-color var(--transition-fast);
  }

  .select-option.mono .option-label {
    font-family: var(--mono);
    font-size: 0.81rem;
    letter-spacing: -0.01em;
  }

  .select-option:hover:not(:disabled),
  .select-option.highlighted:not(:disabled) {
    background: var(--surface-3);
    color: var(--text);
    border-color: color-mix(in srgb, var(--border-hover) 60%, transparent);
  }

  .select-option.selected {
    background: var(--accent-subtle);
    color: #ffffff;
    font-weight: 600;
  }

  .select-option.selected:hover {
    background: color-mix(in srgb, var(--accent-subtle) 80%, var(--surface-3));
  }

  .option-content {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  .option-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .option-description {
    font-size: 0.72rem;
    color: var(--text-dim);
    margin-top: 0.1rem;
  }

  .option-extras {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex: none;
  }

  .option-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.12rem 0.4rem;
    font-size: 0.68rem;
    font-weight: 600;
    line-height: 1;
    border-radius: var(--radius-xs);
    background: var(--surface-3);
    color: var(--text-dim);
    border: 1px solid var(--border);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .trigger-badge {
    background: color-mix(in srgb, var(--accent) 12%, var(--surface-2));
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
    color: var(--accent-hover);
  }

  .check-icon {
    color: var(--accent);
    flex: none;
  }
</style>
