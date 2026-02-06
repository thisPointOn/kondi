// PDF text extraction
// This is a basic implementation - for production use, consider pdf-parse or pdf.js

export interface PdfExtractResult {
  text: string;
  pageCount?: number;
  metadata?: Record<string, string>;
}

export async function extractPdfText(buffer: ArrayBuffer): Promise<PdfExtractResult> {
  // Convert buffer to string to look for text markers
  const bytes = new Uint8Array(buffer);

  // Check PDF magic number
  const header = String.fromCharCode(...bytes.slice(0, 5));
  if (header !== '%PDF-') {
    throw new Error('Not a valid PDF file');
  }

  // Basic text extraction by looking for text streams
  // This is a simplified approach - real PDF parsing is complex
  const text = extractTextFromPdfBytes(bytes);

  if (text.length < 50) {
    // PDF might be image-based or use complex encoding
    return {
      text: '[PDF content could not be extracted - may be image-based or use unsupported encoding]',
      pageCount: undefined,
    };
  }

  return {
    text: cleanPdfText(text),
    pageCount: countPdfPages(bytes),
  };
}

function extractTextFromPdfBytes(bytes: Uint8Array): string {
  const content = new TextDecoder('latin1').decode(bytes);
  const textParts: string[] = [];

  // Look for text between BT (begin text) and ET (end text) markers
  const btPattern = /BT\s*([\s\S]*?)\s*ET/g;
  let match;

  while ((match = btPattern.exec(content)) !== null) {
    const textBlock = match[1];

    // Extract text from Tj and TJ operators
    const tjPattern = /\(([^)]*)\)\s*Tj/g;
    let tjMatch;
    while ((tjMatch = tjPattern.exec(textBlock)) !== null) {
      textParts.push(decodePdfString(tjMatch[1]));
    }

    // TJ operator with array
    const tjArrayPattern = /\[(.*?)\]\s*TJ/g;
    let tjArrayMatch;
    while ((tjArrayMatch = tjArrayPattern.exec(textBlock)) !== null) {
      const arrayContent = tjArrayMatch[1];
      const stringPattern = /\(([^)]*)\)/g;
      let strMatch;
      while ((strMatch = stringPattern.exec(arrayContent)) !== null) {
        textParts.push(decodePdfString(strMatch[1]));
      }
    }
  }

  // Also look for stream content that might contain readable text
  const streamPattern = /stream\s*([\s\S]*?)\s*endstream/g;
  while ((match = streamPattern.exec(content)) !== null) {
    const streamContent = match[1];
    // Look for readable ASCII text in streams
    const readableText = streamContent.match(/[A-Za-z0-9\s.,!?;:'"()-]{20,}/g);
    if (readableText) {
      textParts.push(...readableText);
    }
  }

  return textParts.join(' ');
}

function decodePdfString(str: string): string {
  // Handle common PDF escape sequences
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function countPdfPages(bytes: Uint8Array): number {
  const content = new TextDecoder('latin1').decode(bytes);

  // Look for /Count in the page tree
  const countMatch = content.match(/\/Count\s+(\d+)/);
  if (countMatch) {
    return parseInt(countMatch[1], 10);
  }

  // Fallback: count /Page objects
  const pageMatches = content.match(/\/Type\s*\/Page[^s]/g);
  return pageMatches ? pageMatches.length : 0;
}

function cleanPdfText(text: string): string {
  return text
    // Remove non-printable characters except newlines and tabs
    .replace(/[^\x20-\x7E\n\t]/g, ' ')
    // Normalize whitespace
    .replace(/[ \t]+/g, ' ')
    // Normalize line breaks
    .replace(/\n{3,}/g, '\n\n')
    // Trim lines
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n')
    .trim();
}

export function isPdf(contentType: string, buffer?: ArrayBuffer): boolean {
  if (contentType.includes('application/pdf')) {
    return true;
  }

  if (buffer) {
    const bytes = new Uint8Array(buffer);
    const header = String.fromCharCode(...bytes.slice(0, 5));
    return header === '%PDF-';
  }

  return false;
}
