/**
 * cli-workdir-guard — deterministic directory containment for Claude CLI workers.
 *
 * Claude Code's own confinement does NOT work in headless `--print` mode
 * (verified empirically): `--permission-mode acceptEdits` still writes escapes,
 * `--allowedTools "Write(//abs/**)"` absolute path rules silently fail to match,
 * and `bypassPermissions` disables confinement entirely. A worker spawned with
 * bypassPermissions escaped its working dir and wrote into the parent git repo.
 *
 * A PreToolUse hook, however, fires under every permission mode and can resolve
 * the real target path. We install one as an inline `node -e` command (base64'd
 * so it needs no on-disk file — works from the webview, which has no fs). It
 * denies any Write/Edit/MultiEdit/NotebookEdit whose resolved path is outside
 * the working directory, and any Bash redirect/mutation targeting an absolute
 * path outside it (reads still allowed). Root = the hook payload's `cwd` (the
 * CLI and webview both spawn claude with cwd = working dir), fallback the
 * KONDI_WORKDIR env var. Workers keep full tool power; they just cannot escape.
 */

const GUARD_SRC = String.raw`
const fs=require('fs'),path=require('path');
let raw='';try{raw=fs.readFileSync(0,'utf8')}catch(e){}
let d={};try{d=JSON.parse(raw)}catch(e){}
const root=path.resolve(d.cwd||process.env.KONDI_WORKDIR||process.cwd());
const ti=d.tool_input||{};const name=d.tool_name||'';
function out(dec,r){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:dec,permissionDecisionReason:r||''}}));process.exit(0)}
function within(p){const a=path.resolve(root,p);return a===root||a.startsWith(root.endsWith('/')?root:root+'/')}
if(name==='Write'||name==='Edit'||name==='MultiEdit'||name==='NotebookEdit'){
  const fp=ti.file_path||ti.path||ti.notebook_path||'';
  if(fp&&!within(fp))return out('deny','Blocked: '+fp+' is outside the council working directory ('+root+'). Write only inside it, e.g. .kondi/workspace/.');
  return out('allow');
}
if(name==='Bash'){
  const cmd=String(ti.command||'');
  const redir=cmd.match(/>>?\s*("[^"]+"|'[^']+'|\S+)/g)||[];
  for(let m of redir){let p=m.replace(/^>>?\s*/,'').replace(/^["']|["']$/g,'');if(/^\/(tmp|dev|proc|var\/folders)\b/.test(p))continue;if(p.startsWith('/')&&!within(p))return out('deny','Blocked Bash redirect to '+p+' outside working dir '+root);}
  const mut=cmd.match(/\b(rm|mv|cp|tee|dd|touch|mkdir|rmdir|truncate|ln|install|chmod|chown)\b[^\n|]*?(\/[^\s'"|;&]+)/g)||[];
  for(let m of mut){const pm=m.match(/(\/[^\s'"|;&]+)\s*$/);if(pm){const p=pm[1];if(/^\/(tmp|dev|proc|var\/folders)\b/.test(p))continue;if(!within(p))return out('deny','Blocked Bash mutation of '+p+' outside working dir '+root);}}
  return out('allow');
}
return out('allow');
`;

/** Cross-environment base64 (node Buffer or browser btoa). */
function toBase64(s: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64');
  // eslint-disable-next-line no-undef
  return btoa(unescape(encodeURIComponent(s)));
}

const GUARD_B64 = toBase64(GUARD_SRC);

/** The hook command — self-contained, no on-disk file required. */
export const WORKDIR_GUARD_COMMAND =
  `node -e "eval(Buffer.from('${GUARD_B64}','base64').toString('utf8'))"`;

/** Settings object to pass to `claude --settings` for write containment. */
export function buildWorkdirGuardSettings(): object {
  return {
    hooks: {
      PreToolUse: [{
        matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
        hooks: [{ type: 'command', command: WORKDIR_GUARD_COMMAND }],
      }],
    },
  };
}
