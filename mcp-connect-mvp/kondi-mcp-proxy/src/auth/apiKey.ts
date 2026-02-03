/**
 * API Key authentication - just adds the key to headers
 */

import type { ApiKeyConfig } from '../types.js';

export function getAuthHeaders(config: ApiKeyConfig): Record<string, string> {
  return {
    [config.headerName]: `${config.headerValuePrefix}${config.key}`,
  };
}
