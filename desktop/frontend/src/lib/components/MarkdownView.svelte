<script lang="ts">
  /**
   * Safe markdown/text renderer for engine-generated content. The renderer
   * (`$lib/markdown`) escapes all input first and only emits its own markup,
   * so `{@html}` below cannot introduce untrusted HTML.
   */
  import { renderMarkdownToHtml } from '$lib/markdown';

  let { text, testid }: { text: string; testid?: string } = $props();

  let html = $derived(renderMarkdownToHtml(text));
</script>

<div class="markdown-view" data-testid={testid}>
  {@html html}
</div>

<style>
  .markdown-view {
    font-size: 0.92rem;
    line-height: 1.6;
    word-break: break-word;
  }
  .markdown-view :global(h1),
  .markdown-view :global(h2),
  .markdown-view :global(h3),
  .markdown-view :global(h4) {
    margin: 0.9rem 0 0.4rem;
    line-height: 1.3;
  }
  .markdown-view :global(h1) {
    font-size: 1.25rem;
  }
  .markdown-view :global(h2) {
    font-size: 1.12rem;
  }
  .markdown-view :global(h3) {
    font-size: 1rem;
  }
  .markdown-view :global(p) {
    margin: 0.45rem 0;
  }
  .markdown-view :global(blockquote) {
    margin: 0.5rem 0;
    padding: 0.15rem 0.75rem;
    border-left: 3px solid var(--border);
    color: var(--text-dim);
  }
  .markdown-view :global(code) {
    font-family: var(--mono);
    font-size: 0.82rem;
    background: var(--surface-2);
    border-radius: 4px;
    padding: 0.05rem 0.3rem;
  }
  .markdown-view :global(pre) {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.7rem;
    overflow-x: auto;
    white-space: pre-wrap;
  }
  .markdown-view :global(pre code) {
    background: transparent;
    padding: 0;
  }
  .markdown-view :global(ul),
  .markdown-view :global(ol) {
    margin: 0.45rem 0;
    padding-left: 1.4rem;
  }
  .markdown-view :global(li) {
    margin: 0.15rem 0;
  }
  .markdown-view :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 0.8rem 0;
  }
</style>
