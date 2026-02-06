import { z } from 'zod';
import { SearxngClient } from '../searxng/client.js';
const searchSchema = {
    query: z.string().describe('Search query. Keep concise — 1-6 words works best.'),
    count: z
        .number()
        .min(1)
        .max(30)
        .optional()
        .default(10)
        .describe('Number of results to return. Default: 10. Max: 30.'),
    categories: z
        .string()
        .optional()
        .default('general')
        .describe('SearXNG search category. Options: general, news, images, videos, science, files, it, map.'),
    time_range: z
        .string()
        .optional()
        .describe('Filter results by time. Options: day, week, month, year.'),
    language: z
        .string()
        .optional()
        .default('en')
        .describe("Search language code (e.g., 'en', 'es', 'fr')."),
};
export function registerSearchTool(server, config) {
    const searxng = new SearxngClient(config.searxng);
    server.tool('web_search', 'Search the web using a local SearXNG instance. Returns titles, URLs, and snippets for each result. Use this to find current information, documentation, articles, and more.', searchSchema, async ({ query, count = 10, categories = 'general', time_range, language = 'en' }) => {
        // Validate inputs
        if (!query || query.trim().length === 0) {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ error: 'Query cannot be empty' }),
                    },
                ],
                isError: true,
            };
        }
        const sanitizedCount = Math.min(Math.max(1, count), 30);
        try {
            const response = await searxng.search({
                query: query.trim(),
                count: sanitizedCount,
                categories,
                time_range,
                language,
            });
            const result = {
                results: response.results,
                query: query.trim(),
                number_of_results: response.results.length,
                search_time: response.search_time,
            };
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown search error';
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            error: message,
                            query: query.trim(),
                            hint: message.includes('unavailable') || message.includes('ECONNREFUSED')
                                ? 'Make sure SearXNG is running. Try: docker compose up -d'
                                : undefined,
                        }),
                    },
                ],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=web-search.js.map