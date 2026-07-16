use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use dirs::data_dir;
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command as StdCommand, Stdio};
use std::sync::Mutex;
use tauri::State;
use tiny_http::Response;
use url::Url;


use crate::commands::*;

// ============================================================================
// Claude Code CLI Wrapper Commands
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCommandResult {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
    pub session_id: Option<String>,
}

/// Run a Claude Code CLI command and return the result
#[tauri::command]
pub async fn run_claude_command(
    args: Vec<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ClaudeCommandResult, String> {
    use std::process::Stdio;
    use tokio::process::Command;

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(120000));

    println!("[Claude CLI] Running: claude {}", args.join(" "));

    let mut cmd = Command::new("claude");
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Fully isolate the nested claude from any parent Claude Code session.
    // If kondi was launched from a Claude Code shell, it inherits the outer
    // session's CLAUDE_CODE_* vars (session id, SSE port, todo state, …) — and
    // without removing them the spawned claude attaches to that session and
    // renders the outer agent's todo list / context. Strip the whole namespace.
    for (key, _) in std::env::vars() {
        if key.starts_with("CLAUDE_CODE") || key == "CLAUDECODE" {
            cmd.env_remove(&key);
        }
    }
    cmd.env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "true");

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let child = cmd.spawn().map_err(|e| {
        format!("Failed to spawn claude command: {}. Is Claude Code installed?", e)
    })?;

    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| "Claude command timed out".to_string())?
        .map_err(|e| format!("Claude command failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    println!("[Claude CLI] Exit code: {:?}", output.status.code());
    if !stderr.is_empty() {
        println!("[Claude CLI] Stderr: {}", &stderr[..std::cmp::min(500, stderr.len())]);
    }

    // Try to extract session_id from JSON output
    let session_id = extract_session_id(&stdout);

    if output.status.success() {
        Ok(ClaudeCommandResult {
            success: true,
            output: stdout,
            error: None,
            session_id,
        })
    } else {
        Ok(ClaudeCommandResult {
            success: false,
            output: stdout,
            error: Some(if stderr.is_empty() {
                format!("Command failed with exit code: {:?}", output.status.code())
            } else {
                stderr
            }),
            session_id,
        })
    }
}

/// Run Claude Code with streaming output, calling back for each event
#[tauri::command]
pub async fn run_claude_streaming(
    args: Vec<String>,
    cwd: Option<String>,
    stdin_input: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ClaudeCommandResult, String> {
    use std::process::Stdio;
    use tokio::process::Command;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000)); // 5 min default
    println!("[Claude CLI Streaming] Running: claude {} (timeout: {}s)", args.join(" "), timeout.as_secs());
    if stdin_input.is_some() {
        println!("[Claude CLI Streaming] Piping message via stdin ({} chars)", stdin_input.as_ref().unwrap().len());
    }

    let mut cmd = Command::new("claude");
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Fully isolate the nested claude from any parent Claude Code session.
    // If kondi was launched from a Claude Code shell, it inherits the outer
    // session's CLAUDE_CODE_* vars (session id, SSE port, todo state, …) — and
    // without removing them the spawned claude attaches to that session and
    // renders the outer agent's todo list / context. Strip the whole namespace.
    for (key, _) in std::env::vars() {
        if key.starts_with("CLAUDE_CODE") || key == "CLAUDECODE" {
            cmd.env_remove(&key);
        }
    }
    cmd.env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "true");

    // If we have stdin input, pipe it; otherwise inherit (no stdin needed)
    if stdin_input.is_some() {
        cmd.stdin(Stdio::piped());
    }

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!("Failed to spawn claude command: {}. Is Claude Code installed?", e)
    })?;

    // Write stdin input if provided (for long messages that exceed CLI arg limits)
    if let Some(input) = &stdin_input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(input.as_bytes()).await.map_err(|e| {
                format!("Failed to write to claude stdin: {}", e)
            })?;
            drop(stdin); // Close stdin to signal EOF
        }
    }

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    let mut full_output = String::new();
    let mut stderr_output = String::new();
    let mut session_id: Option<String> = None;
    let mut final_result: Option<String> = None;
    let mut stream_errors: Vec<String> = Vec::new();

    // Read stdout line by line (stream-json format) with timeout
    let read_result = tokio::time::timeout(timeout, async {
        loop {
            tokio::select! {
                line = stdout_reader.next_line() => {
                    match line {
                        Ok(Some(text)) => {
                            full_output.push_str(&text);
                            full_output.push('\n');

                            // Try to parse as JSON and extract session_id, result, or errors
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                                if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                                    session_id = Some(sid.to_string());
                                }
                                let event_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                if event_type == "result" {
                                    if let Some(result_val) = json.get("result") {
                                        // Handle result as string, or stringify if it's another type
                                        if let Some(s) = result_val.as_str() {
                                            final_result = Some(s.to_string());
                                        } else if !result_val.is_null() {
                                            final_result = Some(result_val.to_string());
                                        }
                                    }
                                }
                                // Capture error events from the stream:
                                // - {"type":"error","error":"..."} — explicit error events
                                // - {"type":"result","is_error":true,"result":"..."} — error results
                                // - {"type":"assistant",...,"error":"rate_limit"} — rate limit / API errors
                                if event_type == "error" {
                                    if let Some(err_msg) = json.get("error").and_then(|v| v.as_str()) {
                                        stream_errors.push(err_msg.to_string());
                                    } else if let Some(err_body) = json.get("body").and_then(|v| v.as_str()) {
                                        stream_errors.push(err_body.to_string());
                                    } else {
                                        stream_errors.push(text.clone());
                                    }
                                }
                                if event_type == "result" {
                                    if json.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
                                        if let Some(err_text) = json.get("result").and_then(|v| v.as_str()) {
                                            stream_errors.push(err_text.to_string());
                                        }
                                    }
                                }
                                if event_type == "assistant" {
                                    if let Some(err_kind) = json.get("error").and_then(|v| v.as_str()) {
                                        // Extract user-facing text from the message content
                                        let msg_text = json.pointer("/message/content/0/text")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or(err_kind);
                                        stream_errors.push(msg_text.to_string());
                                    }
                                }
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            println!("[Claude CLI] Error reading stdout: {}", e);
                            break;
                        }
                    }
                }
                line = stderr_reader.next_line() => {
                    match line {
                        Ok(Some(text)) => {
                            println!("[Claude CLI stderr] {}", text);
                            stderr_output.push_str(&text);
                            stderr_output.push('\n');
                        }
                        Ok(None) => {}
                        Err(_) => {}
                    }
                }
            }
        }
    }).await;

    if read_result.is_err() {
        // Timeout — kill the child process and return error
        let _ = child.kill().await;
        println!("[Claude CLI Streaming] TIMEOUT after {}s", timeout.as_secs());
        return Ok(ClaudeCommandResult {
            success: false,
            output: final_result.unwrap_or(full_output),
            error: Some(format!("Claude CLI timed out after {}s. This may be caused by unreachable MCP servers.", timeout.as_secs())),
            session_id,
        });
    }

    let status = child.wait().await.map_err(|e| format!("Failed to wait for process: {}", e))?;

    println!("[Claude CLI Streaming] Completed with status: {:?}", status.code());

    if !status.success() {
        // Build a detailed error message, preferring structured error info over raw stdout
        let stderr_trimmed = stderr_output.trim();
        let error_detail = if !stderr_trimmed.is_empty() {
            format!("Command failed (exit code {:?}): {}", status.code(), stderr_trimmed)
        } else if !stream_errors.is_empty() {
            // Use errors captured from stream-json {"type":"error"} events
            let errors_joined = stream_errors.join("; ");
            format!("Command failed (exit code {:?}): {}", status.code(), errors_joined)
        } else if !full_output.trim().is_empty() {
            // Last resort: extract the tail of stdout which is more likely to contain the error
            // than the head (which is typically just the init event with the tool list)
            let trimmed = full_output.trim();
            let preview = if trimmed.len() > 2000 {
                // Show last 1500 chars — the error is usually near the end
                format!("...(earlier output omitted)\n{}", &trimmed[trimmed.len()-1500..])
            } else {
                trimmed.to_string()
            };
            format!("Command failed (exit code {:?}). stdout: {}", status.code(), preview)
        } else {
            format!("Command failed with exit code: {:?} (no output)", status.code())
        };

        println!("[Claude CLI Streaming] Error: {}", error_detail);

        return Ok(ClaudeCommandResult {
            success: false,
            output: final_result.unwrap_or(full_output),
            error: Some(error_detail),
            session_id,
        });
    }

    // Even with exit code 0, the stream may contain errors:
    // - {"type":"result","is_error":true} — e.g. tool result too large
    // - {"type":"error"} — stream-level errors
    // - stderr warnings that indicate problems
    // Return these as failures so the user sees the error in chat.
    if !stream_errors.is_empty() {
        let errors_joined = stream_errors.join("; ");
        println!("[Claude CLI Streaming] Stream errors (exit 0): {}", errors_joined);
        return Ok(ClaudeCommandResult {
            success: false,
            output: final_result.unwrap_or(full_output),
            error: Some(errors_joined),
            session_id,
        });
    }

    // Check stderr for errors even on exit code 0 (e.g. "Error: result exceeds maximum...")
    let stderr_trimmed = stderr_output.trim();
    if !stderr_trimmed.is_empty() && stderr_trimmed.to_lowercase().contains("error") {
        println!("[Claude CLI Streaming] stderr error (exit 0): {}", stderr_trimmed);
        return Ok(ClaudeCommandResult {
            success: false,
            output: final_result.unwrap_or(full_output),
            error: Some(stderr_trimmed.to_string()),
            session_id,
        });
    }

    // Prefer the explicit result event, but fall back to full stream output
    // if the result is missing or empty (e.g. max-turns reached before final answer)
    let output = match final_result {
        Some(ref r) if !r.trim().is_empty() => r.clone(),
        _ => full_output,
    };

    Ok(ClaudeCommandResult {
        success: true,
        output,
        error: None,
        session_id,
    })
}

/// Run Claude Code login (interactive, opens browser)
#[tauri::command]
pub async fn run_claude_login() -> Result<ClaudeCommandResult, String> {
    use std::process::Stdio;

    println!("[Claude CLI] Running login flow...");

    // For login, we need to run claude interactively
    // This is tricky from a GUI app - we'll spawn it and let it open the browser
    let output = std::process::Command::new("claude")
        .arg("login")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("CLAUDECODE")
        .spawn()
        .map_err(|e| format!("Failed to spawn claude login: {}", e))?
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for claude login: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(ClaudeCommandResult {
            success: true,
            output: stdout,
            error: None,
            session_id: None,
        })
    } else {
        Ok(ClaudeCommandResult {
            success: false,
            output: stdout,
            error: Some(stderr),
            session_id: None,
        })
    }
}

/// Helper to extract session_id from Claude Code JSON output
pub(crate) fn extract_session_id(output: &str) -> Option<String> {
    // Look for session_id in JSON lines
    for line in output.lines() {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                return Some(sid.to_string());
            }
        }
    }
    None
}

// ============================================================================
// Codex CLI Wrapper Commands (OpenAI)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCommandResult {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
    pub session_id: Option<String>,  // Codex calls this thread_id internally
}

/// Run a Codex CLI command and return the result
#[tauri::command]
pub async fn run_codex_command(
    args: Vec<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    input: Option<String>,
) -> Result<CodexCommandResult, String> {
    use std::process::Stdio;
    use tokio::process::Command;
    use tokio::io::AsyncWriteExt;

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(120000));

    println!("[Codex CLI] Running: codex {}", args.join(" "));

    let mut cmd = Command::new("codex");
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("CLAUDECODE")  // Prevent Claude Code env from interfering
        // Non-interactive: prevent child tools (npm, git, pip, etc.) from prompting
        .env("CI", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("NPM_CONFIG_YES", "true")
        .env("PIP_NO_INPUT", "1")
        .env("DEBIAN_FRONTEND", "noninteractive");

    // Spawn Codex in its own process group so we can kill the entire tree on timeout
    #[cfg(unix)]
    cmd.process_group(0);

    if input.is_some() {
        cmd.stdin(Stdio::piped());
    }

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!("Failed to spawn codex command: {}. Is Codex CLI installed?", e)
    })?;

    // Capture PID before wait_with_output() consumes the child.
    // With process_group(0), PID == PGID so we can kill the whole group.
    let child_pid = child.id();

    // Pipe stdin if input was provided
    if let Some(ref input_text) = input {
        if let Some(mut stdin) = child.stdin.take() {
            let text = input_text.clone();
            tokio::spawn(async move {
                let _ = stdin.write_all(text.as_bytes()).await;
                let _ = stdin.shutdown().await;
            });
        }
    }

    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(result) => result.map_err(|e| format!("Codex command failed: {}", e))?,
        Err(_) => {
            // Timeout — kill the entire process group (negative PID) to reap
            // Codex AND any child processes (test runners, build tools, etc.)
            if let Some(pid) = child_pid {
                println!("[Codex CLI] Killing timed-out process group (pgid {})", pid);
                let _ = StdCommand::new("kill")
                    .args(["-9", &format!("-{}", pid)])
                    .output();
            }
            return Err(format!("Codex command timed out after {}s", timeout.as_secs()));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    println!("[Codex CLI] Exit code: {:?}", output.status.code());
    if !stderr.is_empty() {
        println!("[Codex CLI] Stderr: {}", &stderr[..std::cmp::min(500, stderr.len())]);
    }

    // Try to extract thread_id from JSONL output
    let thread_id = extract_codex_thread_id(&stdout);

    if output.status.success() {
        Ok(CodexCommandResult {
            success: true,
            output: stdout,
            error: None,
            session_id: thread_id,
        })
    } else {
        Ok(CodexCommandResult {
            success: false,
            output: stdout,
            error: Some(if stderr.is_empty() {
                format!("Command failed with exit code: {:?}", output.status.code())
            } else {
                stderr
            }),
            session_id: thread_id,
        })
    }
}

/// Run Codex with streaming output
#[tauri::command]
pub async fn run_codex_streaming(
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<CodexCommandResult, String> {
    use std::process::Stdio;
    use tokio::process::Command;
    use tokio::io::{AsyncBufReadExt, BufReader};

    println!("[Codex CLI Streaming] Running: codex {}", args.join(" "));

    let mut cmd = Command::new("codex");
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("CLAUDECODE")
        // Non-interactive: prevent child tools from prompting
        .env("CI", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("NPM_CONFIG_YES", "true")
        .env("PIP_NO_INPUT", "1")
        .env("DEBIAN_FRONTEND", "noninteractive");

    // Own process group so orphaned children can be reaped
    #[cfg(unix)]
    cmd.process_group(0);

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!("Failed to spawn codex command: {}. Is Codex CLI installed?", e)
    })?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    let mut full_output = String::new();
    let mut stderr_output = String::new();
    let mut thread_id: Option<String> = None;
    let mut final_message: Option<String> = None;

    // Read stdout line by line (JSONL format)
    loop {
        tokio::select! {
            line = stdout_reader.next_line() => {
                match line {
                    Ok(Some(text)) => {
                        full_output.push_str(&text);
                        full_output.push('\n');

                        // Try to parse as JSONL and extract thread_id or final message
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(tid) = json.get("thread_id").and_then(|v| v.as_str()) {
                                thread_id = Some(tid.to_string());
                            }

                            let event_type = json.get("type").and_then(|v| v.as_str());

                            // Check for item.completed with agent_message
                            if event_type == Some("item.completed") {
                                if let Some(item) = json.get("item") {
                                    let item_type = item.get("type").and_then(|v| v.as_str());
                                    if item_type == Some("agent_message") {
                                        if let Some(msg_text) = item.get("text").and_then(|v| v.as_str()) {
                                            // Append to final message (there might be multiple)
                                            if final_message.is_none() {
                                                final_message = Some(msg_text.to_string());
                                            } else {
                                                final_message = Some(format!("{}\n\n{}", final_message.unwrap_or_default(), msg_text));
                                            }
                                        }
                                    }
                                }
                            }

                            // Also check turn.completed for backwards compatibility
                            if event_type == Some("turn.completed") {
                                if let Some(msg) = json.get("final_message").and_then(|v| v.as_str()) {
                                    if final_message.is_none() {
                                        final_message = Some(msg.to_string());
                                    }
                                }
                            }

                            // Capture errors from JSON
                            if event_type == Some("error") {
                                if let Some(msg) = json.get("message").and_then(|v| v.as_str()) {
                                    stderr_output.push_str(msg);
                                    stderr_output.push('\n');
                                }
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        println!("[Codex CLI] Error reading stdout: {}", e);
                        break;
                    }
                }
            }
            line = stderr_reader.next_line() => {
                match line {
                    Ok(Some(text)) => {
                        println!("[Codex CLI stderr] {}", text);
                        stderr_output.push_str(&text);
                        stderr_output.push('\n');
                    }
                    Ok(None) => {}
                    Err(_) => {}
                }
            }
        }
    }

    let status = child.wait().await.map_err(|e| format!("Failed to wait for process: {}", e))?;

    println!("[Codex CLI Streaming] Completed with status: {:?}", status.code());

    let error_msg = if status.success() {
        None
    } else {
        Some(if stderr_output.trim().is_empty() {
            format!("Codex command failed with exit code: {:?}", status.code())
        } else {
            stderr_output.trim().to_string()
        })
    };

    Ok(CodexCommandResult {
        success: status.success(),
        output: final_message.unwrap_or(full_output),
        error: error_msg,
        session_id: thread_id,
    })
}

/// Helper to extract thread_id from Codex JSONL output
pub(crate) fn extract_codex_thread_id(output: &str) -> Option<String> {
    for line in output.lines() {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(tid) = json.get("thread_id").and_then(|v| v.as_str()) {
                return Some(tid.to_string());
            }
        }
    }
    None
}

// ============================================================================
// Codex Config Management
// ============================================================================

/// Get the Codex config file path
pub(crate) fn get_codex_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home.join(".codex").join("config.toml"))
}

/// Sanitize a name for use as a TOML bare key.
/// Replaces spaces and other invalid characters with underscores.
pub(crate) fn sanitize_toml_key(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

/// Run mcp-remote to trigger OAuth and cache tokens
/// This opens a browser for the user to authorize, then exits once connected
#[tauri::command]
pub async fn run_mcp_remote_auth(url: String, timeout_ms: u64) -> Result<serde_json::Value, String> {
    use tokio::time::{timeout, Duration};
    use tokio::io::{AsyncBufReadExt, BufReader};

    println!("[MCP Remote Auth] Starting OAuth for: {}", url);

    // Run: npx -y mcp-remote <url>
    let mut child = tokio::process::Command::new("npx")
        .args(["-y", "mcp-remote", &url])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start mcp-remote: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    let mut connected = false;
    let mut error_msg: Option<String> = None;

    // Wait for connection or timeout
    let result = timeout(Duration::from_millis(timeout_ms), async {
        loop {
            tokio::select! {
                line = stdout_reader.next_line() => {
                    match line {
                        Ok(Some(text)) => {
                            println!("[MCP Remote Auth stdout] {}", text);
                            // Check for successful connection
                            if text.contains("Proxy established successfully") ||
                               text.contains("Connected to remote server") {
                                connected = true;
                                break;
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            error_msg = Some(format!("stdout error: {}", e));
                            break;
                        }
                    }
                }
                line = stderr_reader.next_line() => {
                    match line {
                        Ok(Some(text)) => {
                            println!("[MCP Remote Auth stderr] {}", text);
                            if text.contains("error") || text.contains("Error") {
                                error_msg = Some(text);
                            }
                        }
                        Ok(None) => {}
                        Err(_) => {}
                    }
                }
            }
        }
    }).await;

    // Kill the process since we just needed OAuth to complete
    let _ = child.kill().await;

    match result {
        Ok(_) => {
            if connected {
                println!("[MCP Remote Auth] OAuth completed successfully");
                Ok(serde_json::json!({ "success": true }))
            } else if let Some(err) = error_msg {
                println!("[MCP Remote Auth] Failed: {}", err);
                Ok(serde_json::json!({ "success": false, "error": err }))
            } else {
                println!("[MCP Remote Auth] Process ended without confirming connection");
                Ok(serde_json::json!({ "success": false, "error": "Connection not confirmed" }))
            }
        }
        Err(_) => {
            let _ = child.kill().await;
            println!("[MCP Remote Auth] Timeout waiting for OAuth");
            Ok(serde_json::json!({ "success": false, "error": "OAuth timeout - user may not have completed authorization" }))
        }
    }
}

/// Update Codex config to add/update an MCP server
#[tauri::command]
pub async fn update_codex_config(
    server_name: String,
    config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let config_path = get_codex_config_path()?;

    // Ensure .codex directory exists
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create .codex directory: {}", e))?;
    }

    // Read existing config or start fresh
    let mut content = if config_path.exists() {
        fs::read_to_string(&config_path).unwrap_or_default()
    } else {
        String::new()
    };

    // Build the new server block in TOML format
    let safe_name = sanitize_toml_key(&server_name);
    let mut server_block = format!("\n[mcp_servers.{}]\n", safe_name);

    if let Some(command) = config.get("command").and_then(|v| v.as_str()) {
        server_block.push_str(&format!("command = \"{}\"\n", command));
    }

    if let Some(args) = config.get("args").and_then(|v| v.as_array()) {
        let args_str: Vec<String> = args
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| format!("\"{}\"", s))
            .collect();
        server_block.push_str(&format!("args = [{}]\n", args_str.join(", ")));
    }

    if let Some(url) = config.get("url").and_then(|v| v.as_str()) {
        server_block.push_str(&format!("url = \"{}\"\n", url));
    }

    if let Some(timeout) = config.get("startup_timeout_sec").and_then(|v| v.as_i64()) {
        server_block.push_str(&format!("startup_timeout_sec = {}\n", timeout));
    }

    if let Some(timeout) = config.get("tool_timeout_sec").and_then(|v| v.as_i64()) {
        server_block.push_str(&format!("tool_timeout_sec = {}\n", timeout));
    }

    if let Some(env) = config.get("env").and_then(|v| v.as_object()) {
        for (key, value) in env {
            if let Some(val) = value.as_str() {
                server_block.push_str(&format!("{} = \"{}\"\n", key, val));
            }
        }
    }

    // Remove existing server block if present (check both sanitized and original names)
    let section_header = format!("[mcp_servers.{}]", safe_name);
    if content.contains(&section_header) {
        // Use regex-like approach to remove the section
        let mut new_content = String::new();
        let mut skip_section = false;

        for line in content.lines() {
            if line.trim().starts_with(&section_header) {
                skip_section = true;
                continue;
            }
            if skip_section && line.trim().starts_with('[') {
                skip_section = false;
            }
            if !skip_section {
                new_content.push_str(line);
                new_content.push('\n');
            }
        }
        content = new_content;
    }

    // Add the new server block
    content.push_str(&server_block);

    // Write back
    fs::write(&config_path, content.trim())
        .map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(serde_json::json!({ "success": true }))
}

/// Remove an MCP server from Codex config
#[tauri::command]
pub async fn remove_codex_mcp_server(server_name: String) -> Result<serde_json::Value, String> {
    let config_path = get_codex_config_path()?;

    if !config_path.exists() {
        return Ok(serde_json::json!({ "success": true }));
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    let section_header = format!("[mcp_servers.{}]", server_name);

    if !content.contains(&section_header) {
        return Ok(serde_json::json!({ "success": true }));
    }

    // Remove the section
    let mut new_content = String::new();
    let mut skip_section = false;

    for line in content.lines() {
        if line.trim().starts_with(&section_header) {
            skip_section = true;
            continue;
        }
        if skip_section && line.trim().starts_with('[') {
            skip_section = false;
        }
        if !skip_section {
            new_content.push_str(line);
            new_content.push('\n');
        }
    }

    // Clean up extra blank lines
    while new_content.contains("\n\n\n") {
        new_content = new_content.replace("\n\n\n", "\n\n");
    }

    fs::write(&config_path, new_content.trim())
        .map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(serde_json::json!({ "success": true }))
}


// ============================================================================
// Generic HTTPS relay (CORS bypass)
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRelayResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// Relay an HTTPS request through the backend for LLM providers whose APIs
/// send no CORS headers (e.g. NVIDIA NIM) — the webview cannot call those
/// directly; reqwest is not subject to CORS. Mirrors `gemini_request` but is
/// provider-agnostic. HTTPS-only so this can't be used to probe localhost.
#[tauri::command]
pub async fn http_relay(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<HttpRelayResponse, String> {
    if !url.starts_with("https://") {
        return Err("http_relay only allows https:// URLs".to_string());
    }
    // Log host+path only (query strings could carry secrets).
    println!(
        "[Relay] {} {}",
        method.to_uppercase(),
        url.split('?').next().unwrap_or(&url)
    );

    // Long timeout: non-streaming council calls on large models can take minutes.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        m => return Err(format!("Unsupported method: {}", m)),
    };

    for (k, v) in &headers {
        request = request.header(k, v);
    }
    if let Some(body) = body {
        request = request.body(body);
    }

    let resp = request.send().await.map_err(|e| {
        let msg = format!("Relay request failed: {}", e);
        println!("[Relay] ERROR {}", msg);
        msg
    })?;
    let status = resp.status().as_u16();
    let mut resp_headers = HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(vs) = v.to_str() {
            resp_headers.insert(k.to_string(), vs.to_string());
        }
    }
    let body = resp.text().await.map_err(|e| {
        let msg = format!("Relay body read failed: {}", e);
        println!("[Relay] ERROR {}", msg);
        msg
    })?;
    println!("[Relay] -> HTTP {} ({} bytes)", status, body.len());

    Ok(HttpRelayResponse { status, headers: resp_headers, body })
}

/// Events emitted by `http_relay_stream` over its IPC channel.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RelayStreamEvent {
    #[serde(rename = "status")]
    Status {
        status: u16,
        headers: HashMap<String, String>,
    },
    /// Base64-encoded raw bytes (base64 keeps multi-byte UTF-8 sequences that
    /// may be split across chunk boundaries intact).
    #[serde(rename = "chunk")]
    Chunk { data: String },
    #[serde(rename = "end")]
    End,
    #[serde(rename = "error")]
    Error { message: String },
}

/// Streaming variant of `http_relay`: forwards response bytes over a Tauri
/// channel AS THEY ARRIVE, so the webview sees a live stream (SSE deltas reach
/// the chat immediately instead of after the full body buffers — a buffered
/// relay trips the chat's 90s no-first-byte watchdog on long generations).
#[tauri::command]
pub async fn http_relay_stream(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    channel: tauri::ipc::Channel<RelayStreamEvent>,
) -> Result<(), String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use futures_util::StreamExt;

    if !url.starts_with("https://") {
        return Err("http_relay_stream only allows https:// URLs".to_string());
    }
    println!(
        "[Relay] {} {} (stream)",
        method.to_uppercase(),
        url.split('?').next().unwrap_or(&url)
    );

    // No total timeout: a live stream can legitimately run for minutes. The
    // webview side idle-aborts stalled streams (streamOnce watchdog).
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        m => return Err(format!("Unsupported method: {}", m)),
    };
    for (k, v) in &headers {
        request = request.header(k, v);
    }
    if let Some(body) = body {
        request = request.body(body);
    }

    let resp = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("Relay request failed: {}", e);
            println!("[Relay] ERROR {}", msg);
            let _ = channel.send(RelayStreamEvent::Error { message: msg.clone() });
            return Err(msg);
        }
    };

    let status = resp.status().as_u16();
    let mut resp_headers = HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(vs) = v.to_str() {
            resp_headers.insert(k.to_string(), vs.to_string());
        }
    }
    let _ = channel.send(RelayStreamEvent::Status { status, headers: resp_headers });

    let mut total: usize = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                total += bytes.len();
                let _ = channel.send(RelayStreamEvent::Chunk { data: B64.encode(&bytes) });
            }
            Err(e) => {
                let msg = format!("Relay stream failed after {} bytes: {}", total, e);
                println!("[Relay] ERROR {}", msg);
                let _ = channel.send(RelayStreamEvent::Error { message: msg });
                return Ok(()); // error delivered in-band; webview surfaces it
            }
        }
    }
    let _ = channel.send(RelayStreamEvent::End);
    println!("[Relay] -> HTTP {} (streamed {} bytes)", status, total);
    Ok(())
}
