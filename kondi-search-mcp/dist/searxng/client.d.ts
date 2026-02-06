import type { SearxngConfig, SearchParams, SearxngResponse } from '../types.js';
export declare class SearxngClient {
    private baseUrl;
    private timeout;
    constructor(config: SearxngConfig);
    search(params: SearchParams): Promise<SearxngResponse>;
    healthCheck(): Promise<boolean>;
    getBaseUrl(): string;
}
//# sourceMappingURL=client.d.ts.map