import TurndownService from 'turndown';

// Configure Turndown for clean markdown output
const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});

// Remove script and style tags completely
turndown.remove(['script', 'style', 'noscript', 'iframe', 'nav', 'footer']);

// Handle code blocks
turndown.addRule('pre', {
  filter: 'pre',
  replacement: (content, node) => {
    const element = node as HTMLPreElement;
    const code = element.querySelector('code');
    const language = code?.className?.match(/language-(\w+)/)?.[1] || '';
    const text = code?.textContent || element.textContent || content;
    return `\n\`\`\`${language}\n${text.trim()}\n\`\`\`\n`;
  },
});

// Handle images with alt text
turndown.addRule('img', {
  filter: 'img',
  replacement: (_, node) => {
    const img = node as HTMLImageElement;
    const alt = img.alt || 'image';
    const src = img.src || '';
    const title = img.title;

    if (!src) return '';

    if (title) {
      return `![${alt}](${src} "${title}")`;
    }
    return `![${alt}](${src})`;
  },
});

// Handle tables
turndown.addRule('table', {
  filter: 'table',
  replacement: (_, node) => {
    const table = node as HTMLTableElement;
    const rows: string[][] = [];

    // Get all rows
    const allRows = table.querySelectorAll('tr');
    allRows.forEach((tr) => {
      const cells: string[] = [];
      tr.querySelectorAll('th, td').forEach((cell) => {
        cells.push((cell.textContent || '').trim().replace(/\|/g, '\\|'));
      });
      if (cells.length > 0) {
        rows.push(cells);
      }
    });

    if (rows.length === 0) return '';

    // Build markdown table
    const lines: string[] = [];
    const colCount = Math.max(...rows.map(r => r.length));

    // Header row
    lines.push('| ' + rows[0].map(c => c || ' ').join(' | ') + ' |');

    // Separator
    lines.push('| ' + Array(colCount).fill('---').join(' | ') + ' |');

    // Data rows
    for (let i = 1; i < rows.length; i++) {
      const paddedRow = [...rows[i]];
      while (paddedRow.length < colCount) paddedRow.push('');
      lines.push('| ' + paddedRow.join(' | ') + ' |');
    }

    return '\n' + lines.join('\n') + '\n';
  },
});

export function htmlToMarkdown(html: string): string {
  try {
    let markdown = turndown.turndown(html);

    // Clean up the markdown
    markdown = markdown
      // Remove excessive blank lines
      .replace(/\n{3,}/g, '\n\n')
      // Remove trailing whitespace from lines
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
      // Trim overall
      .trim();

    return markdown;
  } catch (error) {
    // If conversion fails, return cleaned text
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

export function createMarkdownExcerpt(markdown: string, maxLength: number = 500): string {
  if (markdown.length <= maxLength) {
    return markdown;
  }

  // Try to cut at a paragraph boundary
  const truncated = markdown.slice(0, maxLength);
  const lastParagraph = truncated.lastIndexOf('\n\n');

  if (lastParagraph > maxLength * 0.5) {
    return truncated.slice(0, lastParagraph).trim() + '\n\n[...]';
  }

  // Try to cut at a sentence
  const lastSentence = truncated.search(/[.!?]\s+[A-Z][^.]*$/);
  if (lastSentence > maxLength * 0.5) {
    return truncated.slice(0, lastSentence + 1).trim() + ' [...]';
  }

  // Cut at word boundary
  const lastSpace = truncated.lastIndexOf(' ');
  return truncated.slice(0, lastSpace).trim() + ' [...]';
}
