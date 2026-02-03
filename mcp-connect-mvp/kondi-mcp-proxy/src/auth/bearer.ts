/**
 * Bearer token authentication
 */

import type { BearerTokenConfig } from '../types.js';

export function getAuthHeaders(config: BearerTokenConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.token}`,
  };
}
