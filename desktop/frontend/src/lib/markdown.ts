/**
 * Minimal, dependency-free markdown renderer for engine-generated content
 * (the write screen's content pane). Input is engine/story text, never
 * trusted HTML: every character is escaped FIRST, then a small block/inline
 * grammar is applied to the escaped text, so the output can only contain
 * markup this module itself emits.
 *
 * Supported (covers what the novel engine emits — prose, chapter drafts,
 * plan notes): fenced code blocks, ATX headings, horizontal rules,
 * blockquotes, ordered/unordered lists, paragraphs, and inline
 * bold/italic/code. Links are rendered as plain text (story content does
 * not need clickable links; avoids any URL-scheme handling). Plain text
 * passes through as paragraphs.
 */

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderInline(escaped: string): string {
  // Inline code first so its content is not further emphasized.
  let html = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold (**x** or __x__), then italic (*x* or _x_).
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  html = html.replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
  return html;
}

interface Block {
  kind: 'paragraph' | 'heading' | 'code' | 'quote' | 'ul' | 'ol' | 'hr';
  level?: number;
  lines: string[];
  lang?: string;
}

function parseBlocks(escapedLines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < escapedLines.length) {
    const line = escapedLines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    // Fenced code block.
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const lang = fence[1]!.trim();
      const body: string[] = [];
      i += 1;
      while (i < escapedLines.length && !/^```/.test(escapedLines[i]!)) {
        body.push(escapedLines[i]!);
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      blocks.push({ kind: 'code', lines: body, lang: lang === '' ? undefined : lang });
      continue;
    }
    // Heading.
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, lines: [heading[2]!] });
      i += 1;
      continue;
    }
    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'hr', lines: [] });
      i += 1;
      continue;
    }
    // Blockquote: consecutive `>` lines.
    if (/^&gt;\s?/.test(line)) {
      const body: string[] = [];
      while (i < escapedLines.length && /^&gt;\s?/.test(escapedLines[i]!)) {
        body.push(escapedLines[i]!.replace(/^&gt;\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', lines: body });
      continue;
    }
    // Lists: consecutive `- `/`* ` (ul) or `N. ` (ol) lines.
    if (/^(\s*)([-*])\s+/.test(line) || /^(\s*)\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const body: string[] = [];
      while (i < escapedLines.length) {
        const current = escapedLines[i]!;
        const isUl = /^(\s*)([-*])\s+/.test(current);
        const isOl = /^\s*\d+\.\s+/.test(current);
        if (ordered ? !isOl : !isUl) break;
        body.push(current.replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: ordered ? 'ol' : 'ul', lines: body });
      continue;
    }
    // Paragraph: consecutive non-special lines.
    const body: string[] = [];
    while (i < escapedLines.length) {
      const current = escapedLines[i]!;
      if (
        current.trim() === '' ||
        /^```/.test(current) ||
        /^#{1,4}\s+/.test(current) ||
        /^(-{3,}|\*{3,}|_{3,})\s*$/.test(current) ||
        /^&gt;\s?/.test(current) ||
        /^(\s*)([-*])\s+/.test(current) ||
        /^\s*\d+\.\s+/.test(current)
      ) {
        break;
      }
      body.push(current);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', lines: body });
  }
  return blocks;
}

/** Render (possibly plain-text) content into a small safe HTML fragment. */
export function renderMarkdownToHtml(text: string): string {
  const escaped = escapeHtml(text.replace(/\r\n/g, '\n'));
  const blocks = parseBlocks(escaped.split('\n'));
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading':
          return `<h${block.level}>${renderInline(block.lines[0] ?? '')}</h${block.level}>`;
        case 'code':
          return `<pre><code>${block.lines.join('\n')}</code></pre>`;
        case 'hr':
          return '<hr />';
        case 'quote':
          return `<blockquote><p>${renderInline(block.lines.join(' '))}</p></blockquote>`;
        case 'ul':
          return `<ul>${block.lines.map((l) => `<li>${renderInline(l)}</li>`).join('')}</ul>`;
        case 'ol':
          return `<ol>${block.lines.map((l) => `<li>${renderInline(l)}</li>`).join('')}</ol>`;
        default:
          return `<p>${renderInline(block.lines.join(' '))}</p>`;
      }
    })
    .join('\n');
}
