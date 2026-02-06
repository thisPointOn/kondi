import { isIP } from 'net';
import type { ValidationResult } from '../types.js';

const PRIVATE_IP_PATTERNS = [
  /^127\./,           // Loopback
  /^10\./,            // Class A private
  /^172\.(1[6-9]|2\d|3[01])\./, // Class B private
  /^192\.168\./,      // Class C private
  /^169\.254\./,      // Link-local
  /^0\./,             // Current network
  /^::1$/,            // IPv6 loopback
  /^fc00:/i,          // IPv6 unique local
  /^fe80:/i,          // IPv6 link-local
  /^fd[0-9a-f]{2}:/i, // IPv6 unique local
];

const LOCALHOST_VARIANTS = [
  'localhost',
  '0.0.0.0',
  '::',
  '[::1]',
  '[::0]',
];

export class UrlValidator {
  private allowedLocalAddresses: Set<string>;
  private blockedDomains: Set<string>;

  constructor(
    allowedLocal: string[] = ['localhost:8888'],
    blockedDomains: string[] = []
  ) {
    this.allowedLocalAddresses = new Set(allowedLocal);
    this.blockedDomains = new Set(blockedDomains.map(d => d.toLowerCase()));
  }

  validate(urlString: string): ValidationResult {
    let parsed: URL;

    try {
      parsed = new URL(urlString);
    } catch {
      return { ok: false, reason: 'Invalid URL. Must include https:// or http://' };
    }

    // Check protocol
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, reason: `Blocked protocol: ${parsed.protocol.replace(':', '')}` };
    }

    const host = parsed.hostname.toLowerCase();
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const hostWithPort = `${host}:${port}`;

    // Check if explicitly allowed local address (e.g., SearXNG)
    if (this.allowedLocalAddresses.has(hostWithPort) || this.allowedLocalAddresses.has(host)) {
      return { ok: true };
    }

    // Check blocked domains
    if (this.blockedDomains.has(host)) {
      return { ok: false, reason: `Blocked domain: ${host}` };
    }

    // Check localhost variants
    if (LOCALHOST_VARIANTS.includes(host)) {
      return { ok: false, reason: 'Blocked: localhost' };
    }

    // Check if it's an IP address
    const cleanHost = host.replace(/^\[|\]$/g, ''); // Remove IPv6 brackets
    if (isIP(cleanHost)) {
      // Check private IP ranges
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(cleanHost)) {
          return { ok: false, reason: 'Blocked: private IP address' };
        }
      }
    }

    // DNS rebinding protection: block hosts that look like IPs with ports
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(host)) {
          return { ok: false, reason: 'Blocked: private IP address' };
        }
      }
    }

    return { ok: true };
  }

  addAllowedLocal(address: string): void {
    this.allowedLocalAddresses.add(address);
  }

  addBlockedDomain(domain: string): void {
    this.blockedDomains.add(domain.toLowerCase());
  }
}
