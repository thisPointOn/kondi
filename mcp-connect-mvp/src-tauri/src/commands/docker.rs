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

/// Check if Docker is available on the system
#[tauri::command]
pub async fn is_docker_available() -> Result<bool, String> {
    let output = StdCommand::new("docker")
        .args(["info"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output();

    match output {
        Ok(o) => Ok(o.status.success()),
        Err(_) => Ok(false),
    }
}

/// Get the status of a Docker container
/// Returns: "running", "stopped", "exited", "not_found", or "docker_unavailable"
#[tauri::command]
pub async fn docker_container_status(container_name: String) -> Result<String, String> {
    let output = StdCommand::new("docker")
        .args(["inspect", "--format", "{{.State.Status}}", &container_name])
        .output();

    match output {
        Ok(o) => {
            if o.status.success() {
                Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                let stderr = String::from_utf8_lossy(&o.stderr);
                if stderr.contains("No such object") || stderr.contains("not found") {
                    Ok("not_found".to_string())
                } else {
                    Ok("not_found".to_string())
                }
            }
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                Ok("docker_unavailable".to_string())
            } else {
                Err(e.to_string())
            }
        }
    }
}

/// Start a stopped Docker container
#[tauri::command]
pub async fn docker_start_container(container_name: String) -> Result<(), String> {
    println!("[Docker] Starting container: {}", container_name);
    let output = StdCommand::new("docker")
        .args(["start", &container_name])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        println!("[Docker] Container started: {}", container_name);
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to start container: {}", stderr.trim()))
    }
}

/// Stop a running Docker container
#[tauri::command]
pub async fn docker_stop_container(container_name: String) -> Result<(), String> {
    println!("[Docker] Stopping container: {}", container_name);
    let output = StdCommand::new("docker")
        .args(["stop", &container_name])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        println!("[Docker] Container stopped: {}", container_name);
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to stop container: {}", stderr.trim()))
    }
}

/// Run docker compose up for a compose file
#[tauri::command]
pub async fn docker_compose_up(
    compose_file: String,
    service_name: Option<String>,
) -> Result<(), String> {
    // Expand ~ to home directory
    let expanded_path = if compose_file.starts_with("~") {
        if let Some(home) = dirs::home_dir() {
            compose_file.replacen("~", home.to_string_lossy().as_ref(), 1)
        } else {
            compose_file
        }
    } else {
        compose_file
    };

    println!("[Docker] Running compose up for: {}", expanded_path);

    let mut args = vec!["compose", "-f", &expanded_path, "up", "-d"];
    if let Some(ref svc) = service_name {
        args.push(svc);
    }

    let output = StdCommand::new("docker")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        println!("[Docker] Compose up succeeded");
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(format!(
            "Docker compose up failed:\nstderr: {}\nstdout: {}",
            stderr.trim(),
            stdout.trim()
        ))
    }
}

/// Run docker compose down for a compose file
#[tauri::command]
pub async fn docker_compose_down(compose_file: String) -> Result<(), String> {
    // Expand ~ to home directory
    let expanded_path = if compose_file.starts_with("~") {
        if let Some(home) = dirs::home_dir() {
            compose_file.replacen("~", home.to_string_lossy().as_ref(), 1)
        } else {
            compose_file
        }
    } else {
        compose_file
    };

    println!("[Docker] Running compose down for: {}", expanded_path);

    let output = StdCommand::new("docker")
        .args(["compose", "-f", &expanded_path, "down"])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        println!("[Docker] Compose down succeeded");
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Docker compose down failed: {}", stderr.trim()))
    }
}

/// Check SearXNG health by making a test search request
#[tauri::command]
pub async fn check_searxng_health(url: String) -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let test_url = format!("{}/search?q=test&format=json", url.trim_end_matches('/'));

    match client.get(&test_url).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

/// Get the Kondi data directory path
#[tauri::command]
pub fn get_kondi_data_dir() -> Result<String, String> {
    data_dir()
        .map(|mut dir| {
            dir.push("kondi");
            let _ = fs::create_dir_all(&dir);
            dir.to_string_lossy().to_string()
        })
        .ok_or_else(|| "Could not determine data directory".to_string())
}

/// Absolute path to the bundled `kondi-guard` write-containment binary.
/// It sits next to the main executable in BOTH dev (target/debug/kondi-guard)
/// and a packaged build (Tauri externalBin places the sidecar alongside the app
/// binary), so the same lookup works everywhere. Returns the path, or an error
/// if it isn't present (the webview then falls back to the Node guard).
#[tauri::command]
pub fn get_guard_binary_path() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("no parent dir for current exe")?;
    let name = if cfg!(windows) { "kondi-guard.exe" } else { "kondi-guard" };
    let p = dir.join(name);
    if p.exists() {
        Ok(p.to_string_lossy().to_string())
    } else {
        Err(format!("guard binary not found at {}", p.display()))
    }
}

/// Ensure SearXNG Docker files exist in Kondi data directory
#[tauri::command]
pub async fn ensure_searxng_files() -> Result<String, String> {
    let data_dir = data_dir()
        .ok_or_else(|| "Could not determine data directory".to_string())?;

    let docker_dir = data_dir.join("kondi").join("docker").join("searxng");
    let config_dir = docker_dir.join("searxng-config");

    // Create directories
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create directories: {}", e))?;

    // Write docker-compose.yml
    let compose_content = r#"version: '3'

services:
  searxng:
    image: searxng/searxng:latest
    container_name: kondi-searxng
    ports:
      - "8888:8080"
    volumes:
      - ./searxng-config:/etc/searxng:rw
    environment:
      - SEARXNG_BASE_URL=http://localhost:8888/
    restart: unless-stopped
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETGID
      - SETUID
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
"#;

    let compose_path = docker_dir.join("docker-compose.yml");
    fs::write(&compose_path, compose_content)
        .map_err(|e| format!("Failed to write docker-compose.yml: {}", e))?;

    // Write settings.yml
    let settings_content = r#"# SearXNG settings for Kondi Search MCP Server
use_default_settings: true

general:
  instance_name: "Kondi Search"
  privacypolicy_url: false
  donation_url: false
  contact_url: false
  enable_metrics: false

search:
  safe_search: 0
  autocomplete: ""
  default_lang: "en"
  formats:
    - html
    - json

server:
  secret_key: "kondi-search-secret-key-change-in-production"
  bind_address: "0.0.0.0:8080"
  method: "GET"
  limiter: false
  image_proxy: false

ui:
  static_use_hash: true
  default_theme: simple
  theme_args:
    simple_style: dark

outgoing:
  request_timeout: 10.0
  max_request_timeout: 15.0
  useragent_suffix: "KondiSearch"

engines:
  - name: google
    engine: google
    shortcut: g
    disabled: false

  - name: bing
    engine: bing
    shortcut: b
    disabled: false

  - name: duckduckgo
    engine: duckduckgo
    shortcut: ddg
    disabled: false

  - name: brave
    engine: brave
    shortcut: br
    disabled: false

  - name: wikipedia
    engine: wikipedia
    shortcut: w
    disabled: false

  - name: github
    engine: github
    shortcut: gh
    disabled: false

  - name: stackoverflow
    engine: stackoverflow
    shortcut: so
    disabled: false
"#;

    let settings_path = config_dir.join("settings.yml");
    fs::write(&settings_path, settings_content)
        .map_err(|e| format!("Failed to write settings.yml: {}", e))?;

    println!("[Docker] SearXNG files created at: {:?}", docker_dir);
    Ok(compose_path.to_string_lossy().to_string())
}

// ============================================================================
// Gemini (Google Cloud Code Assist) OAuth + API Proxy
// ============================================================================

// Gemini OAuth credentials — reads from env vars, then falls back to
// ~/.local/share/kondi/gemini_oauth.json (written on first setup).
// No secrets are compiled into the binary.
pub(crate) fn load_gemini_oauth_config() -> Option<(String, String)> {
    if let Some(path) = data_dir_file("gemini_oauth.json") {
        if let Ok(contents) = fs::read_to_string(&path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) {
                let id = json.get("client_id").and_then(|v| v.as_str()).map(String::from);
                let secret = json.get("client_secret").and_then(|v| v.as_str()).map(String::from);
                if let (Some(id), Some(secret)) = (id, secret) {
                    return Some((id, secret));
                }
            }
        }
    }
    None
}

pub(crate) fn gemini_client_id() -> String {
    if let Ok(val) = std::env::var("KONDI_GEMINI_CLIENT_ID") {
        return val;
    }
    if let Some((id, _)) = load_gemini_oauth_config() {
        return id;
    }
    String::new()
}
pub(crate) fn gemini_client_secret() -> String {
    if let Ok(val) = std::env::var("KONDI_GEMINI_CLIENT_SECRET") {
        return val;
    }
    if let Some((_, secret)) = load_gemini_oauth_config() {
        return secret;
    }
    String::new()
}
const GEMINI_AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GEMINI_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const GEMINI_CALLBACK_PORT: u16 = 8085;
const GEMINI_SCOPES: &str = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";
const GEMINI_CLOUDCODE_BASE: &str = "https://cloudcode-pa.googleapis.com";

#[derive(serde::Serialize, serde::Deserialize)]
pub struct GeminiOAuthResult {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub project_id: String,
    pub email: Option<String>,
}

/// Start Gemini OAuth flow — opens browser, waits for callback, exchanges code,
/// provisions Cloud Code Assist project, and returns tokens + project ID.
#[tauri::command]
pub async fn start_gemini_oauth() -> Result<GeminiOAuthResult, String> {
    let redirect_uri = format!("http://localhost:{}/oauth2callback", GEMINI_CALLBACK_PORT);

    // Generate PKCE
    let code_verifier: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect();
    let challenge_bytes = Sha256::digest(code_verifier.as_bytes());
    let code_challenge = URL_SAFE_NO_PAD.encode(challenge_bytes);

    // Generate state
    let state: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();

    let client_id = gemini_client_id();
    let client_secret = gemini_client_secret();

    let auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        GEMINI_AUTH_ENDPOINT,
        client_id,
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(GEMINI_SCOPES),
        code_challenge,
        state
    );

    println!("[Gemini OAuth] Starting OAuth flow...");

    // Start callback server
    let callback_handle = tokio::spawn(async move {
        wait_for_oauth_callback(GEMINI_CALLBACK_PORT, 300).await
    });

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    if let Err(e) = webbrowser::open(&auth_url) {
        println!("[Gemini OAuth] Failed to open browser: {}. URL: {}", e, auth_url);
    }

    let (code, returned_state) = callback_handle.await
        .map_err(|e| format!("Callback task failed: {}", e))?
        .map_err(|e| format!("OAuth callback error: {}", e))?;

    if returned_state != state {
        return Err("OAuth state mismatch".to_string());
    }

    // Exchange code for tokens
    let client = reqwest::Client::new();
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("code_verifier", code_verifier.as_str()),
    ];

    println!("[Gemini OAuth] Exchanging code for tokens...");

    let resp = client
        .post(GEMINI_TOKEN_ENDPOINT)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Gemini token exchange failed: HTTP {} - {}", status, text));
    }

    let token_json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let access_token = token_json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("No access_token in response")?
        .to_string();

    let refresh_token = token_json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .ok_or("No refresh_token in response")?
        .to_string();

    let expires_in = token_json
        .get("expires_in")
        .and_then(|v| v.as_i64())
        .unwrap_or(3600);
    let expires_at = chrono::Utc::now().timestamp_millis() + (expires_in * 1000);

    // Get user email from userinfo
    let email = match client
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            r.json::<serde_json::Value>().await.ok()
                .and_then(|v| v.get("email").and_then(|e| e.as_str()).map(|s| s.to_string()))
        }
        _ => None,
    };

    println!("[Gemini OAuth] Got tokens, email: {:?}", email);

    // Provision Cloud Code Assist project
    println!("[Gemini OAuth] Provisioning Cloud Code Assist project...");
    let provision_resp = client
        .post(format!("{}/v1internal:loadCodeAssist", GEMINI_CLOUDCODE_BASE))
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Content-Type", "application/json")
        .header("User-Agent", "google-cloud-sdk vscode_cloudshelleditor/0.1")
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("Project provisioning failed: {}", e))?;

    let project_id = if provision_resp.status().is_success() {
        let pv: serde_json::Value = provision_resp.json().await.unwrap_or_default();
        println!("[Gemini OAuth] Provision response: {:?}", pv);
        // Code Assist returns the project under `cloudaicompanionProject`
        // (older shape used `project`). Read both.
        pv.get("cloudaicompanionProject")
            .or_else(|| pv.get("project"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                // Try onboardUser as fallback
                println!("[Gemini OAuth] No project in response, trying onboardUser...");
                String::new()
            })
    } else {
        let status = provision_resp.status();
        let text = provision_resp.text().await.unwrap_or_default();
        println!("[Gemini OAuth] Provision failed: HTTP {} - {}, trying onboardUser...", status, text);
        String::new()
    };

    // If no project from loadCodeAssist, try onboardUser
    let final_project_id = if project_id.is_empty() {
        let onboard_resp = client
            .post(format!("{}/v1internal:onboardUser", GEMINI_CLOUDCODE_BASE))
            .header("Authorization", format!("Bearer {}", access_token))
            .header("Content-Type", "application/json")
            .header("User-Agent", "google-cloud-sdk vscode_cloudshelleditor/0.1")
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|e| format!("Onboard request failed: {}", e))?;

        if onboard_resp.status().is_success() {
            let ov: serde_json::Value = onboard_resp.json().await.unwrap_or_default();
            println!("[Gemini OAuth] Onboard response: {:?}", ov);
            // onboardUser returns a long-running op; the project can be nested
            // under response.cloudaicompanionProject.id or at the top level.
            ov.get("cloudaicompanionProject")
                .or_else(|| ov.pointer("/response/cloudaicompanionProject"))
                .and_then(|v| v.get("id").and_then(|i| i.as_str()).or_else(|| v.as_str()))
                .or_else(|| ov.get("project").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .unwrap_or_else(|| "default-project".to_string())
        } else {
            println!("[Gemini OAuth] Onboard also failed, using default project");
            "default-project".to_string()
        }
    } else {
        project_id
    };

    println!("[Gemini OAuth] Successfully connected! Project: {}", final_project_id);

    Ok(GeminiOAuthResult {
        access_token,
        refresh_token,
        expires_at,
        project_id: final_project_id,
        email,
    })
}

/// Refresh a Gemini OAuth token
#[tauri::command]
pub async fn refresh_gemini_token(refresh_token: String) -> Result<OAuthTokens, String> {
    let client_id = gemini_client_id();
    let client_secret = gemini_client_secret();
    let client = reqwest::Client::new();
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
    ];

    let resp = client
        .post(GEMINI_TOKEN_ENDPOINT)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Refresh request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Gemini token refresh failed: HTTP {} - {}", status, text));
    }

    let token_json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let access_token = token_json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("No access_token in refresh response")?
        .to_string();

    // Google refresh doesn't return a new refresh_token — reuse the old one
    let new_refresh = token_json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or(&refresh_token)
        .to_string();

    let expires_in = token_json
        .get("expires_in")
        .and_then(|v| v.as_i64())
        .unwrap_or(3600);
    let expires_at = chrono::Utc::now().timestamp_millis() + (expires_in * 1000);

    Ok(OAuthTokens {
        access_token,
        refresh_token: new_refresh,
        expires_at,
        token_type: "Bearer".to_string(),
        provider: "google".to_string(),
    })
}

/// Proxy requests to Gemini's cloudcode-pa.googleapis.com endpoint (CORS bypass)
#[tauri::command]
#[allow(non_snake_case)]
pub async fn gemini_request(
    path: String,
    method: String,
    body: Option<String>,
    accessToken: String,
) -> Result<String, String> {
    let url = format!("{}{}", GEMINI_CLOUDCODE_BASE, path);
    println!("[Gemini Request] {} {}", method, path);
    // A real timeout so a slow/stuck cloudcode-pa stream can't hang the chat forever.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
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
        .header("Authorization", format!("Bearer {}", accessToken))
        .header("User-Agent", "google-cloud-sdk vscode_cloudshelleditor/0.1");

    if let Some(body) = body {
        request = request.body(body);
    }

    let resp = request.send().await.map_err(|e| format!("Gemini request failed: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    println!("[Gemini Request] {} -> HTTP {} ({} bytes)", path, status, text.len());
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }

    Ok(text)
}

// ============================================================================
// MCP Process Cleanup (for app exit)
// ============================================================================

/// Stop all running MCP processes (called on app exit)
pub fn stop_all_mcp_processes(state: &AppState) {
    if let Ok(mut processes) = state.mcp_processes.lock() {
        let server_ids: Vec<String> = processes.keys().cloned().collect();
        for server_id in server_ids {
            if let Some(mut process) = processes.remove(&server_id) {
                println!("[MCP] Stopping MCP process on exit: {}", server_id);
                let _ = process.child.kill();
                let _ = process.child.wait();
            }
        }
        println!("[MCP] All MCP processes stopped");
    }
}
