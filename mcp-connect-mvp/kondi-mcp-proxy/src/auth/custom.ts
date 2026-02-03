/**
 * Custom headers authentication
 */

import type { CustomHeadersConfig } from '../types.js';

export function getAuthHeaders(config: CustomHeadersConfig): Record<string, string> {
  return { ...config };
}
