/**
 * Shared input-template semantics — the ONE implementation of the
 * `{{input}}` contract used everywhere a step consumes upstream output:
 * the pipeline executor (GUI + CLI) and the council workflow-runner.
 *
 * Substitutions:
 *   {{input}}            all inputs joined (display form, '---' separated)
 *   {{input[N]}}         one input by index (indexBase declares 0- or 1-based)
 *   {{input.path}}       dot-path into the LAST input parsed as JSON
 *   {{input[N].path}}    dot-path into one input parsed as JSON
 *   {{file}}             all input file paths, newline-joined
 *   {{file[N]}}          one input's file path
 *   'none'               empty string (step sees only its own task)
 *
 * Caller-specific concerns stay with the caller: the executor wraps inputs
 * with provenance headers via `display` and layers `{{memory.*}}` on the
 * result; the workflow-runner numbers inputs 1-based to match the step rail.
 */

/** One upstream output available to a template. */
export interface TemplateInput {
  /** What {{input}}/{{input[N]}} substitute (may carry provenance headers). */
  display: string;
  /** Unwrapped content — what {{input.path}} JSON-parses. */
  raw: string;
  /** Output file path, if the producing step wrote one ({{file}}). */
  filePath?: string | null;
}

/**
 * Extract a clean JSON value from a model response. Weaker workers wrap JSON
 * in prose, ```json fences, or narration; best-effort recovery of the largest
 * valid JSON block, else the original content unchanged.
 */
export function extractJsonBlock(raw: string): string {
  if (!raw) return raw;
  const tryParse = (s: string): string | null => {
    try { return JSON.stringify(JSON.parse(s.trim()), null, 2); } catch { return null; }
  };
  // 0. Already valid JSON.
  const whole = tryParse(raw);
  if (whole) return whole;
  // 1. A ```json … ``` (or bare ```) fenced block.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { const p = tryParse(fence[1]); if (p) return p; }
  // 2. The largest balanced {...} or [...] span in the text.
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = raw.indexOf(open);
    const end = raw.lastIndexOf(close);
    if (start !== -1 && end > start) { const p = tryParse(raw.slice(start, end + 1)); if (p) return p; }
  }
  return raw;
}

/**
 * Parse content as JSON and walk a dot-separated path. Falls back to
 * extractJsonBlock when the content wraps its JSON in prose/fences.
 * Returns the stringified value at the path, or '' on any failure.
 */
export function resolveJsonPath(content: string, dotPath: string): string {
  const walk = (source: string): string | null => {
    try {
      let obj = JSON.parse(source);
      for (const key of dotPath.split('.')) {
        if (obj == null || typeof obj !== 'object') return null;
        obj = obj[key];
      }
      if (obj === undefined || obj === null) return null;
      return typeof obj === 'string' ? obj : JSON.stringify(obj);
    } catch {
      return null;
    }
  };
  return walk(content) ?? walk(extractJsonBlock(content)) ?? '';
}

export interface RenderTemplateOptions {
  /** What N in {{input[N]}} counts from: 0 (pipeline artifact index) or 1 (rail step number). */
  indexBase: 0 | 1;
}

/** Render the core template against the available inputs. */
export function renderCoreTemplate(
  template: string | undefined,
  inputs: TemplateInput[],
  { indexBase }: RenderTemplateOptions,
): string {
  // "none" means no input from previous steps — step only sees its task.
  if (template === 'none') return '';

  const joined = () => inputs.map((i) => i.display).join('\n\n---\n\n');
  if (!template || template === '{{input}}') return joined();

  const at = (n: string): TemplateInput | undefined => inputs[parseInt(n, 10) - indexBase];

  return template
    .replace(/\{\{input\}\}/g, joined())
    .replace(/\{\{input\[(\d+)\]\.([a-zA-Z0-9_.]+)\}\}/g, (_m, n, path) => {
      const input = at(n);
      return input ? resolveJsonPath(input.raw, path) : '';
    })
    .replace(/\{\{input\[(\d+)\]\}\}/g, (_m, n) => at(n)?.display ?? '')
    .replace(/\{\{input\.([a-zA-Z0-9_.]+)\}\}/g, (_m, path) => {
      const last = inputs[inputs.length - 1];
      return last ? resolveJsonPath(last.raw, path) : '';
    })
    .replace(/\{\{file\}\}/g, inputs.map((i) => i.filePath).filter(Boolean).join('\n'))
    .replace(/\{\{file\[(\d+)\]\}\}/g, (_m, n) => at(n)?.filePath || '');
}
