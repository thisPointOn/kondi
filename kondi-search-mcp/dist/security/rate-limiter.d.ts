export declare class RateLimiter {
    private limits;
    private maxRequests;
    private windowMs;
    constructor(maxRequestsPerMinute?: number);
    allow(domain: string): boolean;
    getRemainingRequests(domain: string): number;
    getResetTime(domain: string): number;
    reset(domain?: string): void;
    cleanup(): void;
}
//# sourceMappingURL=rate-limiter.d.ts.map