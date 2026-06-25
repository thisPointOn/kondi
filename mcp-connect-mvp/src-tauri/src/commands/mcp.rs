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

#[tauri::command]
pub async fn mcp_request(
    url: String,
    method: String,
    body: Option<String>,
    access_token: Option<String>,
    session_id: Option<String>,
) -> Result<McpResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300)) // 5 min timeout for MCP tool calls
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => return Err(format!("Unsupported method: {}", method)),
    };

    request = request
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream");

    if let Some(token) = access_token {
        request = request.header("Authorization", format!("Bearer {}", token));
    }

    if let Some(sid) = &session_id {
        request = request.header("Mcp-Session-Id", sid);
    }

    if let Some(body) = body {
        request = request.body(body);
    }

    let resp = request.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // Extract session ID from response headers
    let response_session_id = resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // If the caller requested a binary (favicon), return base64
    let is_favicon = url.to_lowercase().ends_with("favicon.ico");
    if is_favicon {
        let bytes = resp.bytes().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("HTTP {}: binary {} bytes", status, bytes.len()));
        }
        let body = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(McpResponse {
            body,
            session_id: response_session_id.or(session_id),
            content_type,
        });
    } else {
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, text));
        }
        return Ok(McpResponse {
            body: text,
            session_id: response_session_id.or(session_id),
            content_type,
        });
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn anthropic_request(
    url: String,
    method: String,
    body: Option<String>,
    apiKey: String,
    betas: Option<Vec<String>>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600)) // 10 min timeout for LLM API calls
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => return Err(format!("Unsupported method: {}", method)),
    };

    // Detect if this is an OAuth token vs API key
    // OAuth tokens: sk-ant-oat01-... (from OAuth flow)
    // API keys: sk-ant-api01-... (from API console)
    // JWT tokens from OAuth may also start with "eyJ"
    let is_oauth_token = apiKey.contains("-oat") || apiKey.starts_with("eyJ");

    request = request
        .header("Content-Type", "application/json")
        .header("anthropic-version", "2023-06-01");

    // Build beta headers — extracted from Claude Code 2.1.77 via ANTHROPIC_LOG=debug
    let beta_string = if let Some(ref custom_betas) = betas {
        // Caller-provided betas override defaults
        let joined = custom_betas.join(",");
        if joined.is_empty() { String::new() } else { joined }
    } else if is_oauth_token {
        "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20".to_string()
    } else {
        String::new()
    };

    if is_oauth_token {
        // OAuth token: use Authorization Bearer header
        request = request.header("Authorization", format!("Bearer {}", apiKey));
    } else {
        // API key: use x-api-key header
        request = request.header("x-api-key", &apiKey);
    }

    if !beta_string.is_empty() {
        request = request.header("anthropic-beta", beta_string);
    }

    if let Some(body) = body {
        request = request.body(body);
    }

    let resp = request.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }

    Ok(text)
}

/// Read Claude CLI credentials from ~/.claude/.credentials.json
/// Returns { accessToken, refreshToken, expiresAt } from the claudeAiOauth field
#[tauri::command]
#[allow(non_snake_case)]
pub async fn read_claude_credentials() -> Result<serde_json::Value, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let creds_path = home.join(".claude").join(".credentials.json");

    if !creds_path.exists() {
        return Err("Claude credentials file not found (~/.claude/.credentials.json)".to_string());
    }

    let content = std::fs::read_to_string(&creds_path)
        .map_err(|e| format!("Failed to read credentials file: {}", e))?;

    let parsed: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse credentials JSON: {}", e))?;

    // Extract claudeAiOauth field
    let oauth = parsed.get("claudeAiOauth")
        .ok_or("No claudeAiOauth field in credentials file")?;

    let access_token = oauth.get("accessToken")
        .and_then(|v| v.as_str())
        .ok_or("No accessToken in claudeAiOauth")?;

    let refresh_token = oauth.get("refreshToken")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let expires_at = oauth.get("expiresAt")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    Ok(serde_json::json!({
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresAt": expires_at
    }))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OAuthDiscovery {
    pub requires_auth: bool,
    pub authorization_endpoint: Option<String>,
    pub token_endpoint: Option<String>,
    pub registration_endpoint: Option<String>,
    pub supports_dynamic_registration: bool,
    pub dynamic_client_id: Option<String>,
    pub dynamic_client_secret: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn probe_server(server_url: String) -> Result<OAuthDiscovery, String> {
    // Check if this is a localhost/local server - use shorter timeout and assume no auth on failure
    let is_local = server_url.contains("localhost") ||
                   server_url.contains("127.0.0.1") ||
                   server_url.contains("0.0.0.0");

    let timeout_secs = if is_local { 3 } else { 10 };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())?;

    // Step 1: Try tools/list without auth to see if auth is required
    let tools_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
        "params": {}
    });

    let probe_result = client
        .post(&server_url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(&tools_body)
        .send()
        .await;

    match probe_result {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                // No auth required
                return Ok(OAuthDiscovery {
                    requires_auth: false,
                    authorization_endpoint: None,
                    token_endpoint: None,
                    registration_endpoint: None,
                    supports_dynamic_registration: false,
                    dynamic_client_id: None,
                    dynamic_client_secret: None,
                    error: None,
                });
            }

            // Check for auth-related status codes
            if status.as_u16() != 401 && status.as_u16() != 403 {
                // For local servers, if probe fails with non-auth error, assume no auth required
                // This handles SSE servers that don't respond to POST
                if is_local {
                    println!("[Probe] Local server returned HTTP {} - assuming no auth required", status);
                    return Ok(OAuthDiscovery {
                        requires_auth: false,
                        authorization_endpoint: None,
                        token_endpoint: None,
                        registration_endpoint: None,
                        supports_dynamic_registration: false,
                        dynamic_client_id: None,
                        dynamic_client_secret: None,
                        error: None,
                    });
                }
                let text = resp.text().await.unwrap_or_default();
                return Err(format!("Server returned HTTP {}: {}", status, text));
            }
        }
        Err(e) => {
            // For local servers, if we can't connect, assume no auth and let normal connection handle it
            if is_local {
                println!("[Probe] Local server probe failed: {} - assuming no auth required", e);
                return Ok(OAuthDiscovery {
                    requires_auth: false,
                    authorization_endpoint: None,
                    token_endpoint: None,
                    registration_endpoint: None,
                    supports_dynamic_registration: false,
                    dynamic_client_id: None,
                    dynamic_client_secret: None,
                    error: None,
                });
            }
            return Err(format!("Failed to connect to server: {}", e));
        }
    }

    // Step 2: Auth is required - discover OAuth endpoints via well-known
    let base_url = Url::parse(&server_url).map_err(|e| format!("Invalid server URL: {}", e))?;
    let base = format!(
        "{}://{}",
        base_url.scheme(),
        base_url.host_str().ok_or("No host in URL")?
    );
    let port_suffix = base_url
        .port()
        .map(|p| format!(":{}", p))
        .unwrap_or_default();
    let base_with_port = format!("{}{}", base, port_suffix);

    let well_known_url = format!("{}/.well-known/oauth-authorization-server", base_with_port);
    let mut authorization_endpoint = format!("{}/oauth/authorize", base_with_port);
    let mut token_endpoint = format!("{}/oauth/token", base_with_port);
    let mut registration_endpoint: Option<String> = None;

    if let Ok(res) = client.get(&well_known_url).send().await {
        if res.status().is_success() {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                if let Some(auth) = json.get("authorization_endpoint").and_then(|v| v.as_str()) {
                    authorization_endpoint = auth.to_string();
                }
                if let Some(token) = json.get("token_endpoint").and_then(|v| v.as_str()) {
                    token_endpoint = token.to_string();
                }
                if let Some(reg) = json.get("registration_endpoint").and_then(|v| v.as_str()) {
                    registration_endpoint = Some(reg.to_string());
                }
            }
        }
    }

    // Step 3: Try dynamic client registration
    let callback_port = 9876;
    let redirect_uri = format!("http://localhost:{}/callback", callback_port);

    let reg_url = registration_endpoint
        .clone()
        .unwrap_or_else(|| format!("{}/oauth/register", base_with_port));

    let reg_body = serde_json::json!({
        "redirect_uris": [redirect_uri],
        "client_name": "Kondi",
        "grant_types": ["authorization_code"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "client_secret_post"
    });

    let reg_result = client
        .post(&reg_url)
        .json(&reg_body)
        .send()
        .await;

    match reg_result {
        Ok(res) if res.status().is_success() => {
            if let Ok(reg_json) = res.json::<serde_json::Value>().await {
                let client_id = reg_json
                    .get("client_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let client_secret = reg_json
                    .get("client_secret")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                if client_id.is_some() {
                    return Ok(OAuthDiscovery {
                        requires_auth: true,
                        authorization_endpoint: Some(authorization_endpoint),
                        token_endpoint: Some(token_endpoint),
                        registration_endpoint,
                        supports_dynamic_registration: true,
                        dynamic_client_id: client_id,
                        dynamic_client_secret: client_secret,
                        error: None,
                    });
                }
            }
        }
        Ok(res) => {
            let status = res.status();
            let _text = res.text().await.unwrap_or_default();
            // Dynamic registration not supported - user needs to provide credentials
            return Ok(OAuthDiscovery {
                requires_auth: true,
                authorization_endpoint: Some(authorization_endpoint),
                token_endpoint: Some(token_endpoint),
                registration_endpoint,
                supports_dynamic_registration: false,
                dynamic_client_id: None,
                dynamic_client_secret: None,
                error: Some(format!(
                    "Dynamic client registration failed (HTTP {}). You'll need to provide OAuth client credentials.",
                    status
                )),
            });
        }
        Err(e) => {
            return Ok(OAuthDiscovery {
                requires_auth: true,
                authorization_endpoint: Some(authorization_endpoint),
                token_endpoint: Some(token_endpoint),
                registration_endpoint,
                supports_dynamic_registration: false,
                dynamic_client_id: None,
                dynamic_client_secret: None,
                error: Some(format!(
                    "Could not reach registration endpoint: {}. You'll need to provide OAuth client credentials.",
                    e
                )),
            });
        }
    }

    // Fallback - registration didn't return a client_id
    Ok(OAuthDiscovery {
        requires_auth: true,
        authorization_endpoint: Some(authorization_endpoint),
        token_endpoint: Some(token_endpoint),
        registration_endpoint,
        supports_dynamic_registration: false,
        dynamic_client_id: None,
        dynamic_client_secret: None,
        error: Some("Dynamic registration did not return a client_id. You'll need to provide OAuth client credentials.".to_string()),
    })
}

// ============================================================================
// GitHub Sidecar / Subprocess Management
// ============================================================================

pub(crate) fn mcp_servers_dir() -> Option<PathBuf> {
    data_dir().map(|mut dir| {
        dir.push("kondi");
        dir.push("mcp_servers");
        let _ = fs::create_dir_all(&dir);
        dir
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GithubInstallResult {
    pub server_path: String,
    pub entrypoint: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Download and extract a GitHub repository
#[tauri::command]
pub async fn download_github_repo(
    repo_url: String,
    reference: Option<String>,
    server_id: String,
) -> Result<GithubInstallResult, String> {
    // Parse GitHub URL to get owner/repo
    let parsed = Url::parse(&repo_url).map_err(|e| format!("Invalid repo URL: {}", e))?;
    if parsed.host_str().unwrap_or_default() != "github.com" {
        return Err("Only github.com repositories are supported".into());
    }

    let segments: Vec<&str> = parsed.path().trim_matches('/').split('/').collect();
    if segments.len() < 2 {
        return Err("Repo URL must be in the form https://github.com/owner/repo".into());
    }
    let owner = segments[0];
    let repo = segments[1];
    let git_ref = reference.unwrap_or_else(|| "main".to_string());

    // Create target directory
    let base_dir = mcp_servers_dir().ok_or("Could not determine data directory")?;
    let server_dir = base_dir.join(&server_id);
    if server_dir.exists() {
        fs::remove_dir_all(&server_dir).map_err(|e| format!("Failed to remove existing dir: {}", e))?;
    }
    fs::create_dir_all(&server_dir).map_err(|e| format!("Failed to create server dir: {}", e))?;

    // Download zip from GitHub
    let zip_url = format!(
        "https://github.com/{}/{}/archive/{}.zip",
        owner, repo, git_ref
    );

    let client = reqwest::Client::new();
    let response = client
        .get(&zip_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download repo: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download repo: HTTP {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    // Extract zip
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open zip: {}", e))?;

    // GitHub zips have a root folder like "repo-main/", we want to extract contents inside it
    let mut root_prefix: Option<String> = None;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let outpath = match file.enclosed_name() {
            Some(path) => path.to_owned(),
            None => continue,
        };

        // Detect root folder prefix on first entry
        if root_prefix.is_none() {
            if let Some(first_component) = outpath.components().next() {
                root_prefix = Some(first_component.as_os_str().to_string_lossy().to_string());
            }
        }

        // Strip the root prefix to flatten extraction
        let stripped_path = if let Some(ref prefix) = root_prefix {
            let mut components = outpath.components();
            let first = components.next();
            if first.map(|c| c.as_os_str().to_string_lossy() == prefix.as_str()).unwrap_or(false) {
                components.as_path().to_path_buf()
            } else {
                outpath.clone()
            }
        } else {
            outpath.clone()
        };

        // Skip if it results in empty path (the root folder itself)
        if stripped_path.as_os_str().is_empty() {
            continue;
        }

        let target_path = server_dir.join(&stripped_path);

        if file.name().ends_with('/') {
            fs::create_dir_all(&target_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut outfile = fs::File::create(&target_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }

        // Set executable permission on Unix for scripts
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if file.unix_mode().map(|m| m & 0o111 != 0).unwrap_or(false) {
                if let Ok(metadata) = fs::metadata(&target_path) {
                    let mut perms = metadata.permissions();
                    perms.set_mode(perms.mode() | 0o111);
                    let _ = fs::set_permissions(&target_path, perms);
                }
            }
        }
    }

    Ok(GithubInstallResult {
        server_path: server_dir.to_string_lossy().to_string(),
        entrypoint: String::new(), // Will be determined later
        success: true,
        error: None,
    })
}

/// Install dependencies for an MCP server (npm install or pip/uv for Python)
#[tauri::command]
pub async fn install_mcp_dependencies(server_path: String, package_manager: Option<String>) -> Result<CommandOutput, String> {
    use std::path::Path;

    let path = Path::new(&server_path);
    if !path.exists() {
        return Err(format!("Server path does not exist: {}", server_path));
    }

    let manager = package_manager.unwrap_or_else(|| "npm".to_string());

    match manager.as_str() {
        "npm" => {
            // Check if package.json exists
            let package_json = path.join("package.json");
            if !package_json.exists() {
                return Ok(CommandOutput {
                    stdout: "No package.json found, skipping npm install".to_string(),
                    stderr: String::new(),
                    exit_code: 0,
                    success: true,
                });
            }

            // Run npm install
            let output = StdCommand::new("npm")
                .arg("install")
                .current_dir(path)
                .output()
                .map_err(|e| format!("Failed to run npm install: {}", e))?;

            Ok(CommandOutput {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                exit_code: output.status.code().unwrap_or(-1),
                success: output.status.success(),
            })
        }
        "uv" | "pip" => {
            // Check if pyproject.toml exists
            let pyproject = path.join("pyproject.toml");
            let requirements = path.join("requirements.txt");

            // Detect python/pip commands
            let _python_cmd = if StdCommand::new("python3").arg("--version").output().is_ok() {
                "python3"
            } else {
                "python"
            };

            let pip_cmd = if StdCommand::new("pip3").arg("--version").output().is_ok() {
                "pip3"
            } else {
                "pip"
            };

            if !pyproject.exists() && !requirements.exists() {
                // Still attempt editable install to .lib so module is importable from source
                let lib_path = path.join(".lib");
                if !lib_path.exists() {
                    fs::create_dir_all(&lib_path).map_err(|e| format!("Failed to create .lib directory: {}", e))?;
                }
                let output = StdCommand::new(pip_cmd)
                    .args(["install", "--target", ".lib", "-e", "."])
                    .current_dir(path)
                    .output()
                    .map_err(|e| format!("Failed to run pip install: {}", e))?;
                return Ok(CommandOutput {
                    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                    stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                    exit_code: output.status.code().unwrap_or(-1),
                    success: output.status.success(),
                });
            }

            // Detect python/pip commands
            let _python_cmd = if StdCommand::new("python3").arg("--version").output().is_ok() {
                "python3"
            } else {
                "python"
            };

            let pip_cmd = if StdCommand::new("pip3").arg("--version").output().is_ok() {
                "pip3"
            } else {
                "pip"
            };

            // Create local lib directory for dependencies
            let lib_path = path.join(".lib");
            if !lib_path.exists() {
                fs::create_dir_all(&lib_path).map_err(|e| format!("Failed to create .lib directory: {}", e))?;
            }

            println!("[MCP Install] Installing dependencies with {} to {:?}", pip_cmd, lib_path);

            // Install dependencies to local directory
            // For pyproject.toml projects, we install the package itself plus deps
            let output = if pyproject.exists() {
                StdCommand::new(pip_cmd)
                    .args(["install", "--target", ".lib", "-e", "."])
                    .current_dir(path)
                    .output()
                    .map_err(|e| format!("Failed to run pip install: {}", e))?
            } else {
                StdCommand::new(pip_cmd)
                    .args(["install", "--target", ".lib", "-r", "requirements.txt"])
                    .current_dir(path)
                    .output()
                    .map_err(|e| format!("Failed to run pip install: {}", e))?
            };

            if !output.status.success() {
                return Ok(CommandOutput {
                    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                    stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                    exit_code: output.status.code().unwrap_or(-1),
                    success: false,
                });
            }

            Ok(CommandOutput {
                stdout: format!(
                    "Installed dependencies to .lib/\n{}",
                    String::from_utf8_lossy(&output.stdout)
                ),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                exit_code: output.status.code().unwrap_or(-1),
                success: output.status.success(),
            })
        }
        _ => {
            Ok(CommandOutput {
                stdout: format!("Unknown package manager: {}, skipping install", manager),
                stderr: String::new(),
                exit_code: 0,
                success: true,
            })
        }
    }
}

/// Install a specific Python package (pinned) into .lib for a local MCP server
#[tauri::command]
pub async fn install_manifest_package(
    server_path: String,
    package_name: String,
    package_version: String,
    index_url: Option<String>,
) -> Result<CommandOutput, String> {
    use std::path::Path;

    let path = Path::new(&server_path);
    if !path.exists() {
        return Err(format!("Server path does not exist: {}", server_path));
    }
    if package_name.trim().is_empty() || package_version.trim().is_empty() {
        return Err("Package name/version required".into());
    }

    let pip_cmd = if StdCommand::new("pip3").arg("--version").output().is_ok() {
        "pip3"
    } else {
        "pip"
    };

    let lib_path = path.join(".lib");
    if !lib_path.exists() {
        fs::create_dir_all(&lib_path).map_err(|e| format!("Failed to create .lib directory: {}", e))?;
    }

    let pkg_spec = format!("{}=={}", package_name.trim(), package_version.trim());
    let mut cmd = StdCommand::new(pip_cmd);
    cmd.arg("install")
        .arg("--upgrade")
        .arg("--target")
        .arg(".lib")
        .arg(&pkg_spec)
        .current_dir(path);
    if let Some(idx) = index_url {
        if !idx.trim().is_empty() {
            cmd.arg("--index-url").arg(idx.trim());
        }
    }

    println!("[Manifest Install] Installing {} using {} in {:?}", pkg_spec, pip_cmd, path);
    let output = cmd.output().map_err(|e| format!("Failed to run pip install: {}", e))?;

    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
        success: output.status.success(),
    })
}

/// Start an MCP server process (stdio transport)
#[tauri::command]
pub fn start_mcp_process(
    server_id: String,
    server_path: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    state: State<AppState>,
) -> Result<bool, String> {
    use std::path::Path;

    let path = Path::new(&server_path);
    if !path.exists() {
        return Err(format!("Server path does not exist: {}", server_path));
    }

    // Check if process already running
    {
        let processes = state.mcp_processes.lock().map_err(|e| e.to_string())?;
        if processes.contains_key(&server_id) {
            return Err("Process already running for this server".to_string());
        }
    }

    println!("[MCP Process] Starting: {} {:?} in {}", command, args, server_path);

    // Start the process
    let mut cmd = StdCommand::new(&command);
    cmd.args(&args)
        .current_dir(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Add custom environment variables if provided
    if let Some(env_vars) = env {
        for (key, value) in env_vars {
            cmd.env(key, value);
        }
    }

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to start process '{}': {}", command, e))?;

    register_active_pid(child.id());


    // Give the process a moment to start and check if it crashed immediately
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Check if process is still running
    match child.try_wait() {
        Ok(Some(status)) => {
            // Process already exited - capture stderr for error message
            let mut stderr_output = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                use std::io::Read;
                let _ = stderr.read_to_string(&mut stderr_output);
            }
            return Err(format!(
                "Process exited immediately with status {}. Error: {}",
                status,
                if stderr_output.is_empty() { "No error output".to_string() } else { stderr_output }
            ));
        }
        Ok(None) => {
            // Process is still running - good
            println!("[MCP Process] Process started successfully");
        }
        Err(e) => {
            return Err(format!("Failed to check process status: {}", e));
        }
    }

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stdout_reader = stdout.map(BufReader::new);

    let mcp_process = McpProcess {
        child,
        stdin,
        stdout_reader,
    };

    let mut processes = state.mcp_processes.lock().map_err(|e| e.to_string())?;
    processes.insert(server_id, mcp_process);

    Ok(true)
}

/// Send a JSON-RPC message to an MCP process via stdin
#[tauri::command]
pub fn send_mcp_message(
    server_id: String,
    message: String,
    state: State<AppState>,
) -> Result<(), String> {
    let mut processes = state.mcp_processes.lock().map_err(|e| e.to_string())?;
    let process = processes.get_mut(&server_id).ok_or("Process not found")?;

    if let Some(ref mut stdin) = process.stdin {
        // MCP over stdio uses newline-delimited JSON
        writeln!(stdin, "{}", message).map_err(|e| format!("Failed to write to stdin: {}", e))?;
        stdin.flush().map_err(|e| format!("Failed to flush stdin: {}", e))?;
        Ok(())
    } else {
        Err("Process stdin not available".to_string())
    }
}

/// Read a JSON-RPC response from an MCP process stdout
#[tauri::command]
pub fn read_mcp_response(
    server_id: String,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    let mut processes = state.mcp_processes.lock().map_err(|e| e.to_string())?;
    let process = processes.get_mut(&server_id).ok_or("Process not found")?;

    if let Some(ref mut reader) = process.stdout_reader {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => Ok(None), // EOF
            Ok(_) => Ok(Some(line.trim_end().to_string())),
            Err(e) => Err(format!("Failed to read from stdout: {}", e)),
        }
    } else {
        Err("Process stdout not available".to_string())
    }
}

/// Stop an MCP process
#[tauri::command]
pub fn stop_mcp_process(server_id: String, state: State<AppState>) -> Result<(), String> {
    let mut processes = state.mcp_processes.lock().map_err(|e| e.to_string())?;
    if let Some(mut process) = processes.remove(&server_id) {
        let _ = process.child.kill();
        let _ = process.child.wait();
    }
    Ok(())
}

/// Check if an MCP process is running
#[tauri::command]
pub fn is_mcp_process_running(server_id: String, state: State<AppState>) -> Result<bool, String> {
    let processes = state.mcp_processes.lock().map_err(|e| e.to_string())?;
    Ok(processes.contains_key(&server_id))
}

/// Get the path where MCP servers are installed
#[tauri::command]
pub fn get_mcp_servers_dir() -> Result<String, String> {
    mcp_servers_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine MCP servers directory".to_string())
}

/// Detect the correct Python command on this system (python3 or python)
#[tauri::command]
pub fn detect_python_command() -> String {
    // Try python3 first (common on Linux/macOS)
    if StdCommand::new("python3").arg("--version").output().is_ok() {
        return "python3".to_string();
    }
    // Fall back to python
    "python".to_string()
}

// ============================================================================
// CLI Credentials (OAuth from CLI tools)
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CLICredentialInfo {
    pub available: bool,
    pub expires_at: Option<i64>,
    pub error: Option<String>,
}

