interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private limits: Map<string, RateLimitEntry> = new Map();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequestsPerMinute: number = 30) {
    this.maxRequests = maxRequestsPerMinute;
    this.windowMs = 60000; // 1 minute window
  }

  allow(domain: string): boolean {
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

  getRemainingRequests(domain: string): number {
    const now = Date.now();
    const normalizedDomain = domain.toLowerCase();
    const entry = this.limits.get(normalizedDomain);

    if (!entry || now - entry.windowStart > this.windowMs) {
      return this.maxRequests;
    }

    return Math.max(0, this.maxRequests - entry.count);
  }

  getResetTime(domain: string): number {
    const normalizedDomain = domain.toLowerCase();
    const entry = this.limits.get(normalizedDomain);

    if (!entry) {
      return 0;
    }

    const resetTime = entry.windowStart + this.windowMs - Date.now();
    return Math.max(0, resetTime);
  }

  reset(domain?: string): void {
    if (domain) {
      this.limits.delete(domain.toLowerCase());
    } else {
      this.limits.clear();
    }
  }

  // Cleanup old entries periodically
  cleanup(): void {
    const now = Date.now();
    for (const [domain, entry] of this.limits) {
      if (now - entry.windowStart > this.windowMs * 2) {
        this.limits.delete(domain);
      }
    }
  }
}
