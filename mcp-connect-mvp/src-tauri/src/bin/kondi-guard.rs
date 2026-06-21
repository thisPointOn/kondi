//! kondi-guard — Claude Code PreToolUse containment hook, as a self-contained
//! binary (no Node dependency). Bundled as a Tauri sidecar so the write-
//! containment guard works on any machine with zero external runtime deps.
//!
//! Reads the PreToolUse hook payload (JSON) on stdin and either stays silent
//! (allow) or prints a deny decision. Root = KONDI_WORKDIR env, falling back to
//! the payload's `cwd`. Denies any Write/Edit/MultiEdit/NotebookEdit whose
//! resolved path is outside the working dir; denies Bash redirects / mutating
//! commands targeting an absolute path outside it (reads allowed). Mirrors
//! src/services/cli-workdir-guard.ts.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// Lexical normalization (resolves `.`/`..` without touching the filesystem).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => { out.pop(); }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn within(root: &Path, target: &str) -> bool {
    let tp = Path::new(target);
    let joined = if tp.is_absolute() { tp.to_path_buf() } else { root.join(tp) };
    let abs = normalize(&joined);
    let root_n = normalize(root);
    abs == root_n || abs.starts_with(&root_n)
}

fn deny(reason: &str) -> ! {
    let out = serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason
        }
    });
    print!("{}", out);
    std::process::exit(0);
}

/// Paths the worker may always touch (scratch / devices), matching the JS guard.
fn is_exempt(p: &str) -> bool {
    p.starts_with("/tmp") || p.starts_with("/dev") || p.starts_with("/proc") || p.starts_with("/var/folders")
}

fn strip_quotes(s: &str) -> &str {
    s.trim_matches(|c| c == '"' || c == '\'')
}

fn main() {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let d: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);

    let cwd = d.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let root_str = std::env::var("KONDI_WORKDIR").ok().filter(|s| !s.is_empty())
        .unwrap_or_else(|| if cwd.is_empty() { ".".to_string() } else { cwd.to_string() });
    let root = normalize(Path::new(&root_str));

    let name = d.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
    let ti = d.get("tool_input");

    if matches!(name, "Write" | "Edit" | "MultiEdit" | "NotebookEdit") {
        let fp = ti
            .and_then(|t| t.get("file_path").or_else(|| t.get("path")).or_else(|| t.get("notebook_path")))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !fp.is_empty() && !within(&root, fp) {
            deny(&format!(
                "Blocked: {} is outside the council working directory ({}). Write only inside it, e.g. .kondi/workspace/.",
                fp, root.display()
            ));
        }
        std::process::exit(0);
    }

    if name == "Bash" {
        let cmd = ti.and_then(|t| t.get("command")).and_then(|v| v.as_str()).unwrap_or("");
        let mutators = ["rm", "mv", "cp", "tee", "dd", "touch", "mkdir", "rmdir", "truncate", "ln", "install", "chmod", "chown"];
        let toks: Vec<&str> = cmd.split_whitespace().collect();
        for (i, tok) in toks.iter().enumerate() {
            // Redirection target: ">file", ">>file", or ">"/">> " followed by a token.
            if let Some(rest) = tok.strip_prefix(">>").or_else(|| tok.strip_prefix('>')) {
                let target = if rest.is_empty() { toks.get(i + 1).copied().unwrap_or("") } else { rest };
                let target = strip_quotes(target);
                if target.starts_with('/') && !is_exempt(target) && !within(&root, target) {
                    deny(&format!("Blocked Bash redirect to {} outside working dir {}", target, root.display()));
                }
            }
            // Mutating command followed somewhere by an absolute path outside root.
            if mutators.contains(&tok.trim_start_matches('|')) {
                for later in &toks[i + 1..] {
                    let p = strip_quotes(later);
                    if p.starts_with('/') && !is_exempt(p) && !within(&root, p) {
                        deny(&format!("Blocked Bash mutation of {} outside working dir {}", p, root.display()));
                    }
                }
            }
        }
        std::process::exit(0);
    }

    std::process::exit(0); // allow everything else
}
