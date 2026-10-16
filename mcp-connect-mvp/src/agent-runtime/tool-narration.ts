/**
 * Fake tool calls — detection and recovery, independent of the model.
 *
 * Two failure shapes keep showing up across providers:
 *   1. A model WITH tools writes the call as TEXT (`read_file("a.ts")`,
 *      `{"name":"run_command","args":{…}}`, `<tool_call>…</tool_call>`,
 *      `Action: list_directory`) instead of using the function-calling interface
 *      — nothing runs, but the prose claims it did.
 *   2. A model WITHOUT tools (manager/consultant phases) narrates tool calls or
 *      emits JSON commands instead of answering.
 *
 * `recoverToolCallsFromText` turns shape 1 into REAL calls when the intent is
 * unambiguous (a known tool name + parseable arguments); the loop then executes
 * them. `looksLikeToolNarration` flags both shapes so callers can retry once
 * with a corrective instruction (`NO_TOOLS_NOTE` / `FAKE_CALL_NOTE`).
 */
import type { LoopToolCall } from './types';

/** Local + Claude Code tool names (the ones models most often fake). */
export const COMMON_TOOL_NAMES = [
  'read_file', 'write_file', 'list_directory', 'run_command', 'edit_file', 'search_files',
  'Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namesAlternation(names: string[]): string {
  return names.map((n) => esc(n.replace(/^s\d+__/, ''))).concat(names.map(esc)).filter((v, i, a) => a.indexOf(v) === i).join('|');
}

/** True when the text contains a tool invocation written as text (any of the known shapes). */
export function looksLikeToolNarration(text: string, toolNames: string[] = COMMON_TOOL_NAMES): boolean {
  if (!text || text.length < 8) return false;
  const names = namesAlternation([...new Set([...toolNames, ...COMMON_TOOL_NAMES])]);
  const patterns = [
    new RegExp(`^\\s*(?:\\*\\*)?Action(?:\\*\\*)?\\s*:\\s*\`?(?:${names})\\b`, 'im'),                      // Action: read_file
    /<\s*(?:tool_call|function_call|invoke|tool_use)\b[^>]*>/i,                                      // <tool_call>…
    new RegExp(`\\{\\s*"(?:name|tool|tool_name|function|action)"\\s*:\\s*"(?:${names})"`, 'i'),        // {"name":"read_file",…
    new RegExp(`(?:^|[^\\w.])(?:${names})\\s*\\(\\s*(?:["'\`{\\[]|\\w+\\s*=)`, 'm'),                      // read_file("a") / run_command(command=…)
    new RegExp(`\\b(?:calling|invoking|executing|running|i(?:'ll| will) (?:now )?(?:call|invoke|run|use))\\s+(?:the\\s+)?\`?(?:${names})\`?\\s+(?:tool|function|now|with|on)\\b`, 'i'),
  ];
  return patterns.some((re) => re.test(text));
}

const ARG_KEYS = ['arguments', 'args', 'params', 'parameters', 'input', 'inputs'];

function pickArgs(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const k of ARG_KEYS) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    if (typeof v === 'string') { try { const p = JSON.parse(v); if (p && typeof p === 'object') return p; } catch { /* not json */ } }
  }
  // Flat shape: {"name":"read_file","path":"a.ts"}
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!['name', 'tool', 'tool_name', 'function', 'action', 'type', 'id'].includes(k)) rest[k] = v;
  return Object.keys(rest).length ? rest : undefined;
}

/** Scan for balanced JSON objects in free text (fenced or inline). */
function* jsonObjects(text: string): Generator<Record<string, unknown>> {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0; let inStr = false; let escp = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) { if (escp) escp = false; else if (ch === '\\') escp = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { try { const o = JSON.parse(text.slice(i, j + 1)); if (o && typeof o === 'object' && !Array.isArray(o)) yield o as Record<string, unknown>; } catch { /* skip */ } i = j; break; } }
    }
  }
}

/** Parse `key="value", key2=123` style args. */
function parseKvArgs(src: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  const re = /(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`|(-?\d+(?:\.\d+)?)|(true|false))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out[m[1]] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[4] !== undefined ? m[4] : m[5] !== undefined ? Number(m[5]) : m[6] === 'true';
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Recover REAL tool calls from text when a model wrote them instead of calling
 * them. Only unambiguous shapes with a KNOWN tool name are recovered:
 *   - JSON objects `{"name"|"tool"|"function": "<tool>", "arguments"|"args"|…: {…}}` (fenced or not)
 *   - `<tool_call>{json}</tool_call>` / `<invoke name="tool">`
 *   - pseudo-calls `tool({"path": "a"})` or `tool(path="a", command="ls")`
 * Tool names may carry the loop's `s<i>__` prefix; bare names map onto it.
 */
export function recoverToolCallsFromText(text: string, toolNames: string[]): LoopToolCall[] {
  if (!text || toolNames.length === 0) return [];
  const byBare = new Map<string, string>();
  for (const n of toolNames) { byBare.set(n, n); byBare.set(n.replace(/^s\d+__/, ''), n); }
  const resolve = (name: unknown): string | undefined => typeof name === 'string' ? byBare.get(name.trim()) : undefined;
  const calls: LoopToolCall[] = [];
  const seen = new Set<string>();
  const push = (name: string, args: Record<string, unknown>) => {
    const key = `${name}:${JSON.stringify(args)}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({ id: `recovered_${calls.length + 1}`, name, args });
  };

  // 1. JSON objects anywhere in the text
  for (const obj of jsonObjects(text)) {
    const name = resolve(obj.name ?? obj.tool ?? obj.tool_name ?? obj.function ?? obj.action);
    if (!name) {
      // {"function": {"name": …, "arguments": …}} (OpenAI shape as text)
      const fn = obj.function as Record<string, unknown> | undefined;
      const inner = fn && typeof fn === 'object' ? resolve(fn.name) : undefined;
      if (inner) push(inner, pickArgs(fn!) || {});
      continue;
    }
    push(name, pickArgs(obj) || {});
  }
  // 2. <invoke name="tool"><parameter name="k">v</parameter></invoke>
  const invokeRe = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/gi;
  let im: RegExpExecArray | null;
  while ((im = invokeRe.exec(text))) {
    const name = resolve(im[1]);
    if (!name) continue;
    const args: Record<string, unknown> = {};
    const pRe = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi;
    let pm: RegExpExecArray | null;
    while ((pm = pRe.exec(im[2]))) args[pm[1]] = pm[2].trim();
    push(name, args);
  }
  // 3. pseudo-calls: tool({...}) or tool(k=v, …)
  const bare = [...new Set([...byBare.keys()])].map(esc).join('|');
  const callRe = new RegExp(`(?:^|[^\\w.])(${bare})\\s*\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`, 'gm');
  let cm: RegExpExecArray | null;
  while ((cm = callRe.exec(text))) {
    const name = resolve(cm[1]);
    if (!name) continue;
    const inner = cm[2].trim();
    if (!inner) continue;
    let args: Record<string, unknown> | undefined;
    if (inner.startsWith('{')) { try { args = JSON.parse(inner); } catch { args = undefined; } }
    if (!args) args = parseKvArgs(inner);
    if (!args && /^["'`]/.test(inner)) {
      // Single positional string → the tool's conventional first argument.
      const v = inner.replace(/^["'`]|["'`]$/g, '');
      const first = /command|bash|run/i.test(name) ? 'command' : 'path';
      args = { [first]: v };
    }
    if (args) push(name, args);
  }
  return calls;
}

/** Appended (once) to a tool-less persona's prompt when it narrated tool calls. */
export const NO_TOOLS_NOTE =
  '\n\nCORRECTION: Your previous reply contained tool calls, JSON commands or "Action:" lines. You have NO tools in this phase and nothing was executed. ' +
  'Answer directly in prose with the requested structure, using only what is in the prompt. Do not mention tools.';

/** Appended (once) to a tool-enabled persona's prompt when it wrote calls as text. */
export const FAKE_CALL_NOTE =
  '\n\nCORRECTION: Your previous reply DESCRIBED tool calls as text (e.g. `read_file(...)` or a JSON command) — nothing was executed and no files were read or written. ' +
  'Tool calls only run through the function-calling interface. Call the tools for real now, then report what ACTUALLY happened; if you are finished, give the final deliverable without pseudo-calls.';

/** Standing reminder for tool-less phases (model-agnostic, cheap). */
export const NO_TOOLS_REMINDER =
  '\n\nNOTE: You have no tools in this phase. Reply in prose with the requested structure — never emit tool calls, JSON commands, `Action:` lines or pseudo-code tool invocations.';
