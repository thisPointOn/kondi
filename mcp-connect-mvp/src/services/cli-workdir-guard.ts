/**
 * cli-workdir-guard — deterministic directory containment for Claude CLI workers.
 *
 * Claude Code's own confinement does NOT work in headless `--print` mode
 * (verified empirically): `--permission-mode acceptEdits` still writes escapes,
 * `--allowedTools "Write(//abs/**)"` absolute path rules silently fail to match,
 * and `bypassPermissions` disables confinement entirely. A worker spawned with
 * bypassPermissions escaped its working dir and wrote into the parent git repo.
 *
 * The ONLY reliable enforcement point is a `PreToolUse` hook (fires under every
 * permission mode). Two hard-won implementation details:
 *
 *  1. **Run the hook from a FILE via two unquoted tokens** (`<node> <file.cjs>`),
 *     NOT an inline `node -e "…"`. Claude Code splits the hook command on
 *     whitespace without a shell, so a quoted `-e "eval(…)"` arg is mangled and
 *     the hook silently never runs (→ writes escape). `touch /tmp/x` works,
 *     `node -e "…"` does not. A bare `<node> <file>` (no quotes) does.
 *  2. **Use the ABSOLUTE node binary.** When claude is spawned by a Node process
 *     (the CLI runner) it runs hooks with a sanitized PATH that excludes nvm/volta
 *     node installs, so a bare `node` is not-found and the hook fails open.
 *
 * The hook denies any Write/Edit/MultiEdit/NotebookEdit whose resolved path is
 * outside the working dir, and any Bash redirect/mutation targeting an absolute
 * path outside it (reads allowed). Root = `KONDI_WORKDIR` env (set by the
 * spawner), falling back to the hook payload's `cwd`. Allow = exit 0 silently
 * (don't interfere); deny = emit the deny JSON. Workers keep full tool power.
 */

/** The guard script, written to disk and invoked as `<node> <thisFile>`. */
export const WORKDIR_GUARD_SRC = String.raw`
const fs=require('fs'),path=require('path');
let raw='';try{raw=fs.readFileSync(0,'utf8')}catch(e){}
let d={};try{d=JSON.parse(raw)}catch(e){}
const root=path.resolve(process.env.KONDI_WORKDIR||d.cwd||process.cwd());
const ti=d.tool_input||{};const name=d.tool_name||'';
function deny(r){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:r}}));process.exit(0)}
function within(p){const a=path.resolve(root,p);return a===root||a.startsWith(root.endsWith('/')?root:root+'/')}
if(name==='Write'||name==='Edit'||name==='MultiEdit'||name==='NotebookEdit'){
  const fp=ti.file_path||ti.path||ti.notebook_path||'';
  if(fp&&!within(fp))return deny('Blocked: '+fp+' is outside the council working directory ('+root+'). Write only inside it, e.g. .kondi/workspace/.');
  process.exit(0);
}
if(name==='Bash'){
  const cmd=String(ti.command||'');
  const redir=cmd.match(/>>?\s*("[^"]+"|'[^']+'|\S+)/g)||[];
  for(let m of redir){let p=m.replace(/^>>?\s*/,'').replace(/^["']|["']$/g,'');if(/^\/(tmp|dev|proc|var\/folders)\b/.test(p))continue;if(p.startsWith('/')&&!within(p))return deny('Blocked Bash redirect to '+p+' outside working dir '+root);}
  const mut=cmd.match(/\b(rm|mv|cp|tee|dd|touch|mkdir|rmdir|truncate|ln|install|chmod|chown)\b[^\n|]*?(\/[^\s'"|;&]+)/g)||[];
  for(let m of mut){const pm=m.match(/(\/[^\s'"|;&]+)\s*$/);if(pm){const p=pm[1];if(/^\/(tmp|dev|proc|var\/folders)\b/.test(p))continue;if(!within(p))return deny('Blocked Bash mutation of '+p+' outside working dir '+root);}}
  process.exit(0);
}
process.exit(0);
`;

/**
 * Build the `--settings` object given the already-resolved hook command
 * (`<absolute-node> <guard-file>` — two unquoted tokens; see file header).
 */
export function workdirGuardSettings(command: string): object {
  return {
    hooks: {
      PreToolUse: [{
        matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
        hooks: [{ type: 'command', command }],
      }],
    },
  };
}
