import { z } from 'zod';
import { UrlValidator } from '../security/url-validator.js';
import { RateLimiter } from '../security/rate-limiter.js';
import { extractReadableContent } from '../extract/readability.js';
import { htmlToMarkdown } from '../extract/markdown.js';
import { extractPdfText, isPdf } from '../extract/pdf.js';
const fetchSchema = {
    url: z.string().url().describe('URL to fetch. Must include scheme (https:// or http://).'),
    extract_mode: z
        .enum(['text', 'raw', 'markdown'])
        .optional()
        .default('text')
        .describe("How to process the page. 'text' extracts readable content (default). 'raw' returns raw HTML. 'markdown' converts to markdown."),
    max_length: z
        .number()
        .optional()
        .default(50000)
        .describe('Maximum content length in characters. Default: 50000. Truncates with notice if exceeded.'),
    timeout_seconds: z
        .number()
        .optional()
        .default(15)
        .describe('Request timeout in seconds. Default: 15.'),
};
export function registerFetchTool(server, config) {
    const urlValidator = new UrlValidator(['localhost:8888'], // Allow SearXNG
    config.fetch.blocked_domains);
    const rateLimiter = new RateLimiter(config.fetch.rate_limit_per_domain);
    // Cleanup rate limiter periodically
    setInterval(() => rateLimiter.cleanup(), 60000);
    server.tool('web_fetch', 'Fetch a web page and extract its readable content. Use after web_search to get full article text from a URL. Supports HTML pages and PDFs.', fetchSchema, async ({ url, extract_mode = 'text', max_length = config.fetch.max_content_length, timeout_seconds = config.fetch.default_timeout_seconds, }) => {
        // Validate URL
        const validation = urlValidator.validate(url);
        if (!validation.ok) {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            error: `URL validation failed: ${validation.reason}`,
                            url,
                        }),
                    },
                ],
                isError: true,
            };
        }
        // Rate limiting
        let domain;
        try {
            domain = new URL(url).hostname;
        }
        catch {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ error: 'Invalid URL', url }),
                    },
                ],
                isError: true,
            };
        }
        if (!rateLimiter.allow(domain)) {
            const resetTime = Math.ceil(rateLimiter.getResetTime(domain) / 1000);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            error: `Rate limited: too many requests to ${domain}`,
                            retry_after_seconds: resetTime,
                        }),
                    },
                ],
                isError: true,
            };
        }
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout_seconds * 1000);
            let response;
            let redirectCount = 0;
            let currentUrl = url;
            // Follow redirects manually to track count
            while (redirectCount < config.fetch.max_redirects) {
                response = await fetch(currentUrl, {
                    headers: {
                        'User-Agent': config.fetch.user_agent,
                        Accept: 'text/html,application/xhtml+xml,application/pdf,*/*',
                        'Accept-Language': 'en-US,en;q=0.9',
                    },
                    redirect: 'manual',
                    signal: controller.signal,
                });
                if (response.status >= 300 && response.status < 400) {
                    const location = response.headers.get('location');
                    if (!location)
                        break;
                    // Resolve relative URLs
                    currentUrl = new URL(location, currentUrl).toString();
                    redirectCount++;
                    // Validate redirect URL
                    const redirectValidation = urlValidator.validate(currentUrl);
                    if (!redirectValidation.ok) {
                        clearTimeout(timeoutId);
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        error: `Redirect blocked: ${redirectValidation.reason}`,
                                        redirect_url: currentUrl,
                                    }),
                                },
                            ],
                            isError: true,
                        };
                    }
                }
                else {
                    break;
                }
            }
            clearTimeout(timeoutId);
            // @ts-expect-error - response is always assigned in the loop
            if (!response.ok) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                // @ts-expect-error - response is always assigned
                                error: `HTTP ${response.status}: ${response.statusText}`,
                                url: currentUrl,
                            }),
                        },
                    ],
                    isError: true,
                };
            }
            // @ts-expect-error - response is always assigned
            const contentType = response.headers.get('content-type') || '';
            // @ts-expect-error - response is always assigned
            const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
            // Check body size limit
            if (contentLength > config.fetch.max_body_size_bytes) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                error: `Response too large: ${Math.round(contentLength / 1024 / 1024)}MB exceeds ${Math.round(config.fetch.max_body_size_bytes / 1024 / 1024)}MB limit`,
                                url: currentUrl,
                            }),
                        },
                    ],
                    isError: true,
                };
            }
            // Handle PDF
            // @ts-expect-error - response is always assigned
            const buffer = await response.arrayBuffer();
            if (isPdf(contentType, buffer)) {
                try {
                    const pdfResult = await extractPdfText(buffer);
                    let content = pdfResult.text;
                    const truncated = content.length > max_length;
                    if (truncated) {
                        content = content.slice(0, max_length) + '\n\n[Content truncated]';
                    }
                    const result = {
                        url: currentUrl,
                        title: `PDF Document${pdfResult.pageCount ? ` (${pdfResult.pageCount} pages)` : ''}`,
                        content,
                        content_type: 'application/pdf',
                        extract_mode: 'text',
                        content_length: content.length,
                        truncated,
                        fetched_at: new Date().toISOString(),
                    };
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                    };
                }
                catch (pdfError) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: `PDF extraction failed: ${pdfError instanceof Error ? pdfError.message : 'Unknown error'}`,
                                    url: currentUrl,
                                }),
                            },
                        ],
                        isError: true,
                    };
                }
            }
            // Handle non-HTML content types
            if (!contentType.includes('text/html') &&
                !contentType.includes('application/xhtml') &&
                !contentType.includes('text/plain')) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                error: `Cannot extract text from ${contentType}`,
                                url: currentUrl,
                                hint: 'This URL points to binary content (image, video, etc.) that cannot be converted to text.',
                            }),
                        },
                    ],
                    isError: true,
                };
            }
            const body = new TextDecoder().decode(buffer);
            let content;
            let title = '';
            if (extract_mode === 'raw') {
                content = body;
                // Try to extract title even in raw mode
                const titleMatch = body.match(/<title[^>]*>([^<]*)<\/title>/i);
                title = titleMatch ? titleMatch[1].trim() : '';
            }
            else if (extract_mode === 'markdown') {
                const extracted = extractReadableContent(body, currentUrl);
                title = extracted.title;
                content = htmlToMarkdown(extracted.content);
            }
            else {
                // text mode (default)
                const extracted = extractReadableContent(body, currentUrl);
                title = extracted.title;
                content = extracted.textContent;
            }
            // Truncate if needed
            const truncated = content.length > max_length;
            if (truncated) {
                content = content.slice(0, max_length) + '\n\n[Content truncated]';
            }
            const result = {
                url: currentUrl,
                title,
                content,
                content_type: contentType,
                extract_mode,
                content_length: content.length,
                truncated,
                fetched_at: new Date().toISOString(),
            };
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (error) {
            let message;
            if (error instanceof Error) {
                if (error.name === 'AbortError') {
                    message = `Request timed out after ${timeout_seconds} seconds`;
                }
                else if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
                    message = `Could not connect to ${domain}`;
                }
                else if (error.message.includes('certificate') || error.message.includes('SSL')) {
                    message = `SSL/TLS error: ${error.message}`;
                }
                else {
                    message = error.message;
                }
            }
            else {
                message = 'Unknown fetch error';
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ error: `Fetch error: ${message}`, url }),
                    },
                ],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=web-fetch.js.map