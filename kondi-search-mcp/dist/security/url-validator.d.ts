import type { ValidationResult } from '../types.js';
export declare class UrlValidator {
    private allowedLocalAddresses;
    private blockedDomains;
    constructor(allowedLocal?: string[], blockedDomains?: string[]);
    validate(urlString: string): ValidationResult;
    addAllowedLocal(address: string): void;
    addBlockedDomain(domain: string): void;
}
//# sourceMappingURL=url-validator.d.ts.map