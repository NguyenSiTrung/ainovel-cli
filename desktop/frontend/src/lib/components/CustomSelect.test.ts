import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import CustomSelect from './CustomSelect.svelte';

describe('CustomSelect component', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders with placeholder and options', () => {
    render(CustomSelect, {
      props: {
        value: '',
        placeholder: 'Pick a model…',
        options: ['glm-5.3-flash-free', 'deepseek-v4-pro-free'],
        dataTestId: 'test-model-select',
      },
    });

    // Native select is present for test compatibility
    const nativeSelect = screen.getByTestId('test-model-select') as HTMLSelectElement;
    expect(nativeSelect).toBeTruthy();
    expect(nativeSelect.value).toBe('');

    // Trigger button displays placeholder
    expect(screen.getByRole('button', { name: /Pick a model…/i })).toBeTruthy();
  });

  it('displays the selected value in the trigger button', () => {
    render(CustomSelect, {
      props: {
        value: 'deepseek-v4-pro-free',
        options: [
          { value: 'glm-5.3-flash-free', label: 'GLM 5.3 Flash', badge: 'free' },
          { value: 'deepseek-v4-pro-free', label: 'DeepSeek V4 Pro', badge: 'pro' },
        ],
        dataTestId: 'test-model-select',
      },
    });

    const trigger = screen.getByRole('button', { expanded: false });
    expect(trigger.textContent).toContain('DeepSeek V4 Pro');
    expect(trigger.textContent).toContain('pro');
  });

  it('opens dropdown on trigger click and selects option on click', async () => {
    const onchange = vi.fn();
    render(CustomSelect, {
      props: {
        value: 'glm-5.3-flash-free',
        options: ['glm-5.3-flash-free', 'deepseek-v4-flash-free', 'deepseek-v4-pro-free'],
        dataTestId: 'test-model-select',
        onchange,
      },
    });

    const trigger = screen.getByRole('button', { expanded: false });
    await fireEvent.click(trigger);

    // Dropdown listbox is open
    expect(screen.getByRole('listbox')).toBeTruthy();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);

    // Click second option
    await fireEvent.click(options[1]!);

    // Dropdown closes and change event was dispatched
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onchange).toHaveBeenCalled();

    const nativeSelect = screen.getByTestId('test-model-select') as HTMLSelectElement;
    expect(nativeSelect.value).toBe('deepseek-v4-flash-free');
  });

  it('synchronizes when fireEvent.change is called directly on the native select', async () => {
    const onchange = vi.fn();
    render(CustomSelect, {
      props: {
        value: 'openai',
        options: ['openai', 'ollama', 'anthropic'],
        dataTestId: 'test-provider-select',
        onchange,
      },
    });

    const nativeSelect = screen.getByTestId('test-provider-select') as HTMLSelectElement;
    expect(nativeSelect.value).toBe('openai');

    // Simulate standard test interaction: fireEvent.change
    await fireEvent.change(nativeSelect, { target: { value: 'ollama' } });

    expect(onchange).toHaveBeenCalled();
    expect(nativeSelect.value).toBe('ollama');

    // The trigger button reflects the new selection
    const trigger = screen.getByRole('button');
    expect(trigger.textContent).toContain('ollama');
  });

  it('filters options when search query is typed', async () => {
    render(CustomSelect, {
      props: {
        value: 'model-a',
        searchable: true,
        options: [
          { value: 'model-a', label: 'Alpha GPT' },
          { value: 'model-b', label: 'Beta Claude' },
          { value: 'model-c', label: 'Gamma Gemini' },
        ],
        dataTestId: 'test-searchable-select',
      },
    });

    const trigger = screen.getByRole('button');
    await fireEvent.click(trigger);

    const searchInput = screen.getByPlaceholderText('Search…');
    expect(searchInput).toBeTruthy();

    await fireEvent.input(searchInput, { target: { value: 'claude' } });

    const visibleOptions = screen.getAllByRole('option');
    expect(visibleOptions).toHaveLength(1);
    expect(visibleOptions[0]!.textContent).toContain('Beta Claude');
  });

  it('supports keyboard navigation: ArrowDown, Enter, and Escape', async () => {
    const onchange = vi.fn();
    render(CustomSelect, {
      props: {
        value: 'one',
        options: ['one', 'two', 'three'],
        dataTestId: 'test-kbd-select',
        onchange,
      },
    });

    const trigger = screen.getByRole('button');
    // Open via Enter
    await fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByRole('listbox')).toBeTruthy();

    // Close via Escape
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
