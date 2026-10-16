/**
 * Agent runtime — tool registry.
 *
 * Models see tools under short, length-safe wire names (`s<i>__<name>`, max 64
 * chars — the same convention the five GUI clients each re-implemented); the
 * registry maps those names back to (executor, real tool name). Schemas are
 * minimized to keep token cost down.
 */
import type { ToolDef, ToolExecutor, ToolCallContext } from './types';

export interface RegisteredTool {
  wireName: string;
  def: ToolDef;              // def.name = wireName (what the model sees)
  source: ToolExecutor;
  realName: string;
}

/** Strip a JSON schema down to type/description/enum/properties/required/items/oneOf/anyOf/allOf. */
export function minimizeSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return (schema as Record<string, unknown>) ?? {};
  const s = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (s.type) result.type = s.type;
  if (typeof s.description === 'string') {
    result.description = s.description.length > 150 ? s.description.slice(0, 147) + '...' : s.description;
  }
  if (s.enum) result.enum = s.enum;
  if (s.properties && typeof s.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) props[k] = minimizeSchema(v);
    result.properties = props;
  }
  if (Array.isArray(s.required) && s.required.length > 0) result.required = s.required;
  if (s.items) result.items = minimizeSchema(s.items);
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(s[key])) result[key] = (s[key] as unknown[]).map(minimizeSchema);
  }
  return result;
}

/**
 * Combine several executors (local tools, each MCP server) into one registry
 * whose wire names are unique and short. `sources[i]` gets prefix `s<i>__`.
 */
export class ToolRegistry implements ToolExecutor {
  private byWire = new Map<string, RegisteredTool>();

  constructor(sources: ToolExecutor[], opts: { filter?: (realName: string, sourceIndex: number) => boolean } = {}) {
    sources.forEach((src, i) => {
      const prefix = `s${i}`;
      for (const def of src.list()) {
        if (opts.filter && !opts.filter(def.name, i)) continue;
        const maxLen = 64 - prefix.length - 2;
        const wireName = `${prefix}__${def.name.length > maxLen ? def.name.slice(0, maxLen) : def.name}`;
        this.byWire.set(wireName, {
          wireName,
          realName: def.name,
          source: src,
          def: { name: wireName, description: (def.description || '').slice(0, 300), inputSchema: minimizeSchema(def.inputSchema) },
        });
      }
    });
  }

  list(): ToolDef[] {
    return [...this.byWire.values()].map((t) => t.def);
  }

  resolve(wireName: string): RegisteredTool | undefined {
    return this.byWire.get(wireName);
  }

  async call(wireName: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
    const t = this.byWire.get(wireName);
    if (!t) throw new Error(`Unknown tool "${wireName}". Available: ${[...this.byWire.keys()].join(', ') || '(none)'}`);
    return t.source.call(t.realName, args, ctx);
  }

  get size(): number {
    return this.byWire.size;
  }
}

/** Wrap a static tool list + call fn as an executor. */
export function simpleExecutor(tools: ToolDef[], call: ToolExecutor['call']): ToolExecutor {
  return { list: () => tools, call };
}

/** Coerce any tool result into the string the loop feeds back to the model. */
export function toolResultToString(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result == null) return '';
  // MCP-style content arrays: [{type:'text', text}]
  if (Array.isArray(result) && result.every((x) => x && typeof x === 'object' && 'type' in x)) {
    return (result as Array<{ type: string; text?: string }>)
      .map((x) => (x.type === 'text' && typeof x.text === 'string' ? x.text : JSON.stringify(x)))
      .join('\n');
  }
  try { return JSON.stringify(result); } catch { return String(result); }
}
