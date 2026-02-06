import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import type { ExtractedContent } from '../types.js';

const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'nav',
  'footer',
  'header',
  'iframe',
  'aside',
  '.ad',
  '.ads',
  '.advertisement',
  '.social-share',
  '.comments',
  '.comment-section',
  '[role="banner"]',
  '[role="navigation"]',
  '[role="complementary"]',
  '[aria-hidden="true"]',
  '.sidebar',
  '.menu',
  '.popup',
  '.modal',
  '.cookie-banner',
  '.newsletter-signup',
];

export function extractReadableContent(html: string, url: string): ExtractedContent {
  // Create a DOM from the HTML
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // Remove noise elements before Readability processes
  for (const selector of NOISE_SELECTORS) {
    try {
      const elements = doc.querySelectorAll(selector);
      elements.forEach((el) => el.remove());
    } catch {
      // Ignore invalid selectors
    }
  }

  // Try Readability extraction
  const reader = new Readability(doc, {
    charThreshold: 100,
    keepClasses: false,
  });

  const article = reader.parse();

  if (article && article.textContent && article.textContent.trim().length > 100) {
    return {
      title: article.title || doc.title || '',
      content: article.content || '',
      textContent: cleanText(article.textContent),
    };
  }

  // Fallback: try to get main content areas
  const mainContent = findMainContent(doc);

  return {
    title: doc.title || '',
    content: mainContent.html,
    textContent: cleanText(mainContent.text),
  };
}

function findMainContent(doc: Document): { html: string; text: string } {
  // Priority order for main content containers
  const contentSelectors = [
    'main',
    'article',
    '[role="main"]',
    '.content',
    '.post-content',
    '.article-content',
    '.entry-content',
    '#content',
    '#main',
    '.main',
  ];

  for (const selector of contentSelectors) {
    const element = doc.querySelector(selector);
    if (element && element.textContent && element.textContent.trim().length > 200) {
      return {
        html: element.innerHTML || '',
        text: element.textContent || '',
      };
    }
  }

  // Last resort: use body
  const body = doc.body;
  return {
    html: body?.innerHTML || '',
    text: body?.textContent || '',
  };
}

function cleanText(text: string): string {
  return text
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    // Remove excessive newlines
    .replace(/\n{3,}/g, '\n\n')
    // Trim each line
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    // Final trim
    .trim();
}

export function extractTitle(html: string): string {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Try og:title first
  const ogTitle = doc.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    const content = ogTitle.getAttribute('content');
    if (content) return content;
  }

  // Try twitter:title
  const twitterTitle = doc.querySelector('meta[name="twitter:title"]');
  if (twitterTitle) {
    const content = twitterTitle.getAttribute('content');
    if (content) return content;
  }

  // Try h1
  const h1 = doc.querySelector('h1');
  if (h1 && h1.textContent) {
    return h1.textContent.trim();
  }

  // Fallback to document title
  return doc.title || '';
}
