export class RateLimiter {
    limits = new Map();
    maxRequests;
    windowMs;
    constructor(maxRequestsPerMinute = 30) {
        this.maxRequests = maxRequestsPerMinute;
        this.windowMs = 60000; // 1 minute window
    }
    allow(domain) {
        const now = Date.now();
        const normalizedDomain = domain.toLowerCase();
        const entry = this.limits.get(normalizedDomain);
        if (!entry) {
            // First request for this domain
            this.limits.set(normalizedDomain, { count: 1, windowStart: now });
            return true;
        }
        // Check if window has expired
        if (now - entry.windowStart > this.windowMs) {
            // Reset the window
            this.limits.set(normalizedDomain, { count: 1, windowStart: now });
            return true;
        }
        // Within window - check limit
        if (entry.count >= this.maxRequests) {
            return false;
        }
        // Increment counter
        entry.count++;
        return true;
    }
    getRemainingRequests(domain) {
        const now = Date.now();
        const normalizedDomain = domain.toLowerCase();
        const entry = this.limits.get(normalizedDomain);
        if (!entry || now - entry.windowStart > this.windowMs) {
            return this.maxRequests;
        }
        return Math.max(0, this.maxRequests - entry.count);
    }
    getResetTime(domain) {
        const normalizedDomain = domain.toLowerCase();
        const entry = this.limits.get(normalizedDomain);
        if (!entry) {
            return 0;
        }
        const resetTime = entry.windowStart + this.windowMs - Date.now();
        return Math.max(0, resetTime);
    }
    reset(domain) {
        if (domain) {
            this.limits.delete(domain.toLowerCase());
        }
        else {
            this.limits.clear();
        }
    }
    // Cleanup old entries periodically
    cleanup() {
        const now = Date.now();
        for (const [domain, entry] of this.limits) {
            if (now - entry.windowStart > this.windowMs * 2) {
                this.limits.delete(domain);
            }
        }
    }
}
//# sourceMappingURL=rate-limiter.js.map