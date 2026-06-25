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
// MCP Proxy Management Commands
// ============================================================================

/// Get the proxies directory path
pub(crate) fn proxies_dir() -> Option<PathBuf> {
    data_dir().map(|mut dir| {
        dir.push("kondi");
        dir.push("proxies");
        let _ = fs::create_dir_all(&dir);
        dir
    })
}

/// Get the proxy logs directory path
pub(crate) fn proxy_logs_dir() -> Option<PathBuf> {
    data_dir().map(|mut dir| {
        dir.push("kondi");
        dir.push("logs");
        let _ = fs::create_dir_all(&dir);
        dir
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfigFile {
    pub id: String,
    pub name: String,
    pub remote_url: String,
    pub transport: String,
    pub local_port: u16,
    pub auth_method: String,
    pub oauth: Option<ProxyOAuthConfig>,
    pub api_key: Option<ProxyApiKeyConfig>,
    pub bearer_token: Option<ProxyBearerTokenConfig>,
    pub custom_headers: Option<HashMap<String, String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyOAuthConfig {
    pub client_id: String,
    pub client_secret: String,
    pub auth_url: String,
    pub token_url: String,
    pub scopes: Vec<String>,
    pub callback_port: u16,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub token_expires_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyApiKeyConfig {
    pub key: String,
    pub header_name: String,
    pub header_value_prefix: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyBearerTokenConfig {
    pub token: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHealthResponse {
    pub status: String,
    pub server_id: String,
    pub server_name: String,
    pub remote_url: String,
    pub auth_method: String,
    pub transport: String,
    pub tool_count: i32,
    pub last_activity: Option<String>,
    pub error: Option<String>,
    pub auth: Option<ProxyAuthInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyAuthInfo {
    pub authenticated: bool,
    pub token_expires_at: Option<i64>,
    pub expires_in_seconds: Option<i64>,
    pub last_refresh_attempt: Option<String>,
    pub last_refresh_result: Option<String>,
}

/// List all proxy configurations
#[tauri::command]
pub fn list_proxy_configs() -> Result<Vec<ProxyConfigFile>, String> {
    let dir = proxies_dir().ok_or("Could not determine proxies directory")?;

    let mut configs = Vec::new();

    if dir.exists() {
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Ok(contents) = fs::read_to_string(&path) {
                    if let Ok(config) = serde_json::from_str::<ProxyConfigFile>(&contents) {
                        configs.push(config);
                    }
                }
            }
        }
    }

    Ok(configs)
}

/// Find a proxy configuration by name (returns None if not found)
pub(crate) fn find_proxy_by_name(name: &str) -> Option<ProxyConfigFile> {
    let dir = proxies_dir()?;

    if dir.exists() {
        for entry in fs::read_dir(&dir).ok()? {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Ok(contents) = fs::read_to_string(&path) {
                    if let Ok(config) = serde_json::from_str::<ProxyConfigFile>(&contents) {
                        if config.name == name {
                            return Some(config);
                        }
                    }
                }
            }
        }
    }

    None
}

/// Get a single proxy configuration by ID
#[tauri::command]
pub fn get_proxy_config(proxy_id: String) -> Result<ProxyConfigFile, String> {
    let dir = proxies_dir().ok_or("Could not determine proxies directory")?;
    let path = dir.join(format!("{}.json", proxy_id));

    if !path.exists() {
        return Err(format!("Proxy config not found: {}", proxy_id));
    }

    let contents = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&contents).map_err(|e| e.to_string())
}

/// Save a proxy configuration
#[tauri::command]
pub fn save_proxy_config(config: ProxyConfigFile) -> Result<(), String> {
    let dir = proxies_dir().ok_or("Could not determine proxies directory")?;
    let path = dir.join(format!("{}.json", config.id));

    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;

    println!("[Proxy] Saved config for {}: {:?}", config.name, path);
    Ok(())
}

/// Delete a proxy configuration
#[tauri::command]
pub fn delete_proxy_config(proxy_id: String, state: State<AppState>) -> Result<(), String> {
    // Stop the proxy if running
    let _ = stop_proxy(proxy_id.clone(), state);

    let dir = proxies_dir().ok_or("Could not determine proxies directory")?;
    let path = dir.join(format!("{}.json", proxy_id));

    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Create a proxy config from an existing server config
/// If a proxy with the same name already exists, return the existing one (updated if needed)
#[tauri::command]
pub fn create_proxy_from_server(
    server: ServerConfig,
    local_port: u16,
    callback_port: u16,
) -> Result<ProxyConfigFile, String> {
    // Check if a proxy with the same name already exists
    if let Some(existing) = find_proxy_by_name(&server.name) {
        println!("[Proxy] Found existing proxy for '{}', reusing config with id: {}", server.name, existing.id);
        // Return the existing config - don't create a duplicate
        return Ok(existing);
    }

    let mut config = ProxyConfigFile {
        id: server.id.clone(),
        name: server.name.clone(),
        remote_url: server.url.clone(),
        transport: server.transport.clone(),
        local_port,
        auth_method: "none".to_string(),
        oauth: None,
        api_key: None,
        bearer_token: None,
        custom_headers: None,
    };

    // Determine auth method from server config
    if server.access_token.is_some() && server.client_id.is_some() {
        // OAuth-authenticated server
        config.auth_method = "oauth".to_string();

        // Parse auth URL and token URL from server URL
        let base_url = Url::parse(&server.url).map_err(|e| format!("Invalid URL: {}", e))?;
        let base = format!(
            "{}://{}{}",
            base_url.scheme(),
            base_url.host_str().ok_or("No host in URL")?,
            base_url.port().map(|p| format!(":{}", p)).unwrap_or_default()
        );

        config.oauth = Some(ProxyOAuthConfig {
            client_id: server.client_id.clone().unwrap_or_default(),
            client_secret: server.client_secret.clone().unwrap_or_default(),
            auth_url: format!("{}/oauth/authorize", base),
            token_url: format!("{}/oauth/token", base),
            scopes: vec!["openid".to_string(), "profile".to_string(), "offline_access".to_string()],
            callback_port,
            access_token: server.access_token.clone(),
            refresh_token: None, // May need to be populated
            token_expires_at: None,
        });
    } else if server.access_token.is_some() {
        // Bearer token auth
        config.auth_method = "bearer_token".to_string();
        config.bearer_token = Some(ProxyBearerTokenConfig {
            token: server.access_token.clone().unwrap_or_default(),
        });
    }

    // Save the config
    save_proxy_config(config.clone())?;

    Ok(config)
}

/// Start a proxy process
#[tauri::command]
pub fn start_proxy(proxy_id: String, state: State<AppState>) -> Result<u16, String> {
    // Check if already running
    {
        let processes = state.proxy_processes.lock().map_err(|e| e.to_string())?;
        if processes.contains_key(&proxy_id) {
            // Return the existing port
            return Ok(processes[&proxy_id].local_port);
        }
    }

    // Get config
    let config = get_proxy_config(proxy_id.clone())?;

    // Get paths
    let dir = proxies_dir().ok_or("Could not determine proxies directory")?;
    let config_path = dir.join(format!("{}.json", proxy_id));
    let log_dir = proxy_logs_dir().ok_or("Could not determine logs directory")?;

    // Find the kondi-mcp-proxy executable
    // First try the built dist version in the project
    let proxy_paths = vec![
        // Development path
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("kondi-mcp-proxy")
            .join("dist")
            .join("index.js"),
        // Production path (bundled with app)
        dirs::data_dir()
            .unwrap_or_default()
            .join("kondi")
            .join("bin")
            .join("kondi-mcp-proxy")
            .join("dist")
            .join("index.js"),
    ];

    let proxy_script = proxy_paths
        .iter()
        .find(|p| p.exists())
        .ok_or("Could not find kondi-mcp-proxy. Please build it first: cd kondi-mcp-proxy && npm run build")?;

    println!(
        "[Proxy] Starting proxy for {} on port {}",
        config.name, config.local_port
    );
    println!("[Proxy] Using proxy script: {:?}", proxy_script);
    println!("[Proxy] Config path: {:?}", config_path);

    // Check if the port is already in use
    if !is_port_available(config.local_port) {
        println!(
            "[Proxy] Port {} is already in use, attempting to kill existing process",
            config.local_port
        );
        if kill_process_on_port(config.local_port) {
            println!("[Proxy] Successfully freed port {}", config.local_port);
        } else {
            // Double check if port is now available
            if !is_port_available(config.local_port) {
                return Err(format!(
                    "Port {} is already in use and could not be freed. Please stop the existing process manually.",
                    config.local_port
                ));
            }
        }
    }

    // Start the proxy process
    let mut cmd = StdCommand::new("node");
    cmd.arg(proxy_script)
        .arg("--config")
        .arg(&config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Set log directory environment variable
    cmd.env("KONDI_LOG_DIR", &log_dir);

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to start proxy process: {}. Ensure Node.js is installed.",
            e
        )
    })?;

    register_active_pid(child.id());


    // Initialize log storage for this proxy
    {
        let mut logs = state.proxy_logs.lock().map_err(|e| e.to_string())?;
        logs.insert(proxy_id.clone(), Vec::new());
    }

    // Capture stdout in a background thread
    let proxy_id_stdout = proxy_id.clone();
    let logs_handle = state.proxy_logs.clone();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    println!("[Proxy:{}] {}", proxy_id_stdout, line);
                    if let Ok(mut logs) = logs_handle.lock() {
                        if let Some(proxy_logs) = logs.get_mut(&proxy_id_stdout) {
                            proxy_logs.push(ProxyLogEntry {
                                timestamp: chrono::Utc::now().to_rfc3339(),
                                level: "info".to_string(),
                                message: line,
                            });
                            // Keep only last 500 entries
                            if proxy_logs.len() > 500 {
                                proxy_logs.remove(0);
                            }
                        }
                    }
                }
            }
        });
    }

    // Capture stderr in a background thread
    let proxy_id_stderr = proxy_id.clone();
    let logs_handle_err = state.proxy_logs.clone();
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    eprintln!("[Proxy:{}:err] {}", proxy_id_stderr, line);
                    if let Ok(mut logs) = logs_handle_err.lock() {
                        if let Some(proxy_logs) = logs.get_mut(&proxy_id_stderr) {
                            proxy_logs.push(ProxyLogEntry {
                                timestamp: chrono::Utc::now().to_rfc3339(),
                                level: "error".to_string(),
                                message: line,
                            });
                            // Keep only last 500 entries
                            if proxy_logs.len() > 500 {
                                proxy_logs.remove(0);
                            }
                        }
                    }
                }
            }
        });
    }

    // Give it a moment to start
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Store the process
    let process = ProxyProcess {
        child,
        config_path: config_path.to_string_lossy().to_string(),
        local_port: config.local_port,
        proxy_name: config.name.clone(),
    };

    {
        let mut processes = state.proxy_processes.lock().map_err(|e| e.to_string())?;
        processes.insert(proxy_id, process);
    }

    println!("[Proxy] Proxy started on port {}", config.local_port);
    Ok(config.local_port)
}

/// Stop a proxy process
#[tauri::command]
pub fn stop_proxy(proxy_id: String, state: State<AppState>) -> Result<(), String> {
    let mut processes = state.proxy_processes.lock().map_err(|e| e.to_string())?;

    if let Some(mut process) = processes.remove(&proxy_id) {
        println!("[Proxy] Stopping proxy: {}", proxy_id);
        let _ = process.child.kill();
        let _ = process.child.wait();
    }

    Ok(())
}

/// Stop all running proxies (called on app exit)
pub fn stop_all_proxies(state: &AppState) {
    if let Ok(mut processes) = state.proxy_processes.lock() {
        let proxy_ids: Vec<String> = processes.keys().cloned().collect();
        for proxy_id in proxy_ids {
            if let Some(mut process) = processes.remove(&proxy_id) {
                println!("[Proxy] Stopping proxy on exit: {}", proxy_id);
                let _ = process.child.kill();
                let _ = process.child.wait();
            }
        }
        println!("[Proxy] All proxies stopped");
    }
}

/// Check if a proxy is running
#[tauri::command]
pub fn is_proxy_running(proxy_id: String, state: State<AppState>) -> Result<bool, String> {
    let processes = state.proxy_processes.lock().map_err(|e| e.to_string())?;
    Ok(processes.contains_key(&proxy_id))
}

/// Get proxy logs
#[tauri::command]
pub fn get_proxy_logs(proxy_id: String, state: State<AppState>) -> Result<Vec<ProxyLogEntry>, String> {
    let logs = state.proxy_logs.lock().map_err(|e| e.to_string())?;
    Ok(logs.get(&proxy_id).cloned().unwrap_or_default())
}

/// Clear proxy logs
#[tauri::command]
pub fn clear_proxy_logs(proxy_id: String, state: State<AppState>) -> Result<(), String> {
    let mut logs = state.proxy_logs.lock().map_err(|e| e.to_string())?;
    if let Some(proxy_logs) = logs.get_mut(&proxy_id) {
        proxy_logs.clear();
    }
    Ok(())
}

/// Get all proxy logs
#[tauri::command]
pub fn get_all_proxy_logs(state: State<AppState>) -> Result<HashMap<String, Vec<ProxyLogEntry>>, String> {
    let logs = state.proxy_logs.lock().map_err(|e| e.to_string())?;
    Ok(logs.clone())
}

/// Get proxy health by calling its /health endpoint
#[tauri::command]
pub async fn get_proxy_health(proxy_id: String, _state: State<'_, AppState>) -> Result<ProxyHealthResponse, String> {
    // Get the port from config
    let config = get_proxy_config(proxy_id.clone())?;

    let health_url = format!("http://127.0.0.1:{}/health", config.local_port);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    match client.get(&health_url).send().await {
        Ok(resp) => {
            if resp.status().is_success() {
                let health: ProxyHealthResponse = resp.json().await.map_err(|e| e.to_string())?;
                Ok(health)
            } else {
                Err(format!("Health check failed: HTTP {}", resp.status()))
            }
        }
        Err(e) => {
            // Proxy might not be running
            Err(format!("Proxy not reachable: {}", e))
        }
    }
}

/// Trigger OAuth flow for a proxy
#[tauri::command]
pub async fn trigger_proxy_auth(proxy_id: String) -> Result<serde_json::Value, String> {
    let config = get_proxy_config(proxy_id.clone())?;

    let auth_url = format!("http://127.0.0.1:{}/auth", config.local_port);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(&auth_url)
        .send()
        .await
        .map_err(|e| format!("Failed to trigger auth: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Auth trigger failed: HTTP {} - {}", status, text));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}

/// Reload proxy config (re-read from disk and reconnect)
#[tauri::command]
pub async fn reload_proxy(proxy_id: String) -> Result<serde_json::Value, String> {
    let config = get_proxy_config(proxy_id.clone())?;

    let reload_url = format!("http://127.0.0.1:{}/reload", config.local_port);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(&reload_url)
        .send()
        .await
        .map_err(|e| format!("Failed to reload proxy: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Reload failed: HTTP {} - {}", status, text));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}

/// Re-authenticate a proxy by re-registering with the OAuth server and getting fresh credentials
/// This is used when OAuth credentials become invalid (e.g., client_id revoked)
#[tauri::command]
pub async fn reauthenticate_proxy(
    _app: tauri::AppHandle,
    proxy_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    println!("[Proxy] Re-authenticating proxy: {}", proxy_id);

    // Get current config
    let mut config = get_proxy_config(proxy_id.clone())?;

    if config.auth_method != "oauth" {
        return Err("Re-authentication only supported for OAuth servers".into());
    }

    // IMPORTANT: Clear the old OAuth credentials from config FIRST
    // This ensures ANY OAuth flow (whether from Tauri or proxy) will do dynamic registration
    // The old client_id may be revoked/invalid on the OAuth server
    if let Some(ref mut oauth) = config.oauth {
        println!("[Proxy] Clearing old OAuth credentials (client_id: {})", oauth.client_id);
        oauth.client_id = String::new();
        oauth.client_secret = String::new();
        oauth.access_token = None;
        oauth.refresh_token = None;
        oauth.token_expires_at = None;
    }

    // Save the cleared config so the proxy won't use old credentials
    save_proxy_config(config.clone())?;
    println!("[Proxy] Cleared OAuth credentials from config file");

    // Stop the proxy if running (we'll restart it after with fresh credentials)
    println!("[Proxy] Stopping proxy...");
    let _ = stop_proxy(proxy_id.clone(), state.clone());

    // Give the process time to fully stop
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    // Use start_oauth_full to do dynamic registration and get ALL credentials in one call
    // This ensures the client_id/secret match the access_token (no mismatch from separate calls)
    // Pass the proxy's callbackPort so the OAuth redirect URI matches
    let cb_port = config.oauth.as_ref().map(|o| o.callback_port);
    println!("[Proxy] Starting OAuth flow with dynamic registration (callback port: {:?})...", cb_port);
    let oauth_result = start_oauth_full(config.remote_url.clone(), cb_port).await?;

    println!("[Proxy] Got new credentials - client_id: {}", oauth_result.client_id);

    // Reload config (in case it was modified)
    config = get_proxy_config(proxy_id.clone())?;

    // Update the config with ALL new credentials from the same OAuth flow
    if let Some(ref mut oauth) = config.oauth {
        oauth.access_token = Some(oauth_result.access_token.clone());
        oauth.refresh_token = oauth_result.refresh_token.clone();
        oauth.token_expires_at = oauth_result.expires_at;
        oauth.client_id = oauth_result.client_id.clone();
        oauth.client_secret = oauth_result.client_secret.clone();
        oauth.auth_url = oauth_result.authorization_endpoint.clone();
        oauth.token_url = oauth_result.token_endpoint.clone();
        println!("[Proxy] Updated OAuth config with new credentials (expires_at: {:?})", oauth_result.expires_at);
    }

    // Save the updated config with new credentials
    save_proxy_config(config.clone())?;

    // Verify config was written correctly by reading it back
    let verify_config = get_proxy_config(proxy_id.clone())?;
    if verify_config.oauth.as_ref().and_then(|o| o.access_token.as_ref()).is_none() {
        return Err("Config verification failed: access_token not found after write".into());
    }
    println!("[Proxy] Config write verified - access_token present");

    // Give the filesystem time to fully flush the config file
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    // Restart the proxy with fresh credentials
    let port = start_proxy(proxy_id.clone(), state)?;

    println!("[Proxy] Re-authentication complete, proxy restarted on port {}", port);

    Ok(serde_json::json!({
        "status": "success",
        "message": "Re-authenticated successfully",
        "port": port,
        "access_token": oauth_result.access_token
    }))
}

/// Get all proxy statuses
#[tauri::command]
pub async fn get_all_proxy_statuses(_state: State<'_, AppState>) -> Result<HashMap<String, ProxyHealthResponse>, String> {
    let configs = list_proxy_configs()?;
    let mut statuses = HashMap::new();

    for config in configs {
        let health_url = format!("http://127.0.0.1:{}/health", config.local_port);

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .map_err(|e| e.to_string())?;

        match client.get(&health_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(health) = resp.json::<ProxyHealthResponse>().await {
                    statuses.insert(config.id.clone(), health);
                }
            }
            _ => {
                // Proxy not running - return offline status
                statuses.insert(
                    config.id.clone(),
                    ProxyHealthResponse {
                        status: "offline".to_string(),
                        server_id: config.id.clone(),
                        server_name: config.name.clone(),
                        remote_url: config.remote_url.clone(),
                        auth_method: config.auth_method.clone(),
                        transport: config.transport.clone(),
                        tool_count: 0,
                        last_activity: None,
                        error: Some("Proxy not running".to_string()),
                        auth: None,
                    },
                );
            }
        }
    }

    Ok(statuses)
}

// ============================================================================
// LLM Config Sync Commands
// ============================================================================

/// Sync proxy to Claude Code config (~/.claude.json)
#[tauri::command]
pub fn sync_proxy_to_claude_config(proxy_id: String) -> Result<(), String> {
    let config = get_proxy_config(proxy_id)?;

    // Claude Code config path
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let claude_config_path = home.join(".claude.json");

    // Read existing config or create new
    let mut claude_config: serde_json::Value = if claude_config_path.exists() {
        let contents = fs::read_to_string(&claude_config_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&contents).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Ensure mcpServers object exists
    if claude_config.get("mcpServers").is_none() {
        claude_config["mcpServers"] = serde_json::json!({});
    }

    // Add/update the server entry pointing to local proxy (with _local_proxy suffix)
    let local_url = format!("http://127.0.0.1:{}/mcp", config.local_port);
    let proxy_entry_name = format!("{}_local_proxy", config.name);
    claude_config["mcpServers"][&proxy_entry_name] = serde_json::json!({
        "type": "http",
        "url": local_url
    });

    // Write back
    let json = serde_json::to_string_pretty(&claude_config).map_err(|e| e.to_string())?;
    fs::write(&claude_config_path, json).map_err(|e| e.to_string())?;

    println!(
        "[Proxy] Synced {} to Claude config: {}",
        proxy_entry_name, local_url
    );
    Ok(())
}

/// Remove proxy from Claude Code config
#[tauri::command]
pub fn remove_proxy_from_claude_config(proxy_name: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let claude_config_path = home.join(".claude.json");

    if !claude_config_path.exists() {
        return Ok(());
    }

    let contents = fs::read_to_string(&claude_config_path).map_err(|e| e.to_string())?;
    let mut claude_config: serde_json::Value =
        serde_json::from_str(&contents).unwrap_or_else(|_| serde_json::json!({}));

    // Remove using _local_proxy suffix
    let proxy_entry_name = format!("{}_local_proxy", proxy_name);
    if let Some(servers) = claude_config.get_mut("mcpServers").and_then(|s| s.as_object_mut()) {
        servers.remove(&proxy_entry_name);
    }

    let json = serde_json::to_string_pretty(&claude_config).map_err(|e| e.to_string())?;
    fs::write(&claude_config_path, json).map_err(|e| e.to_string())?;

    Ok(())
}

/// Sync proxy to Codex config (~/.codex/config.toml)
#[tauri::command]
pub fn sync_proxy_to_codex_config(proxy_id: String) -> Result<(), String> {
    let config = get_proxy_config(proxy_id)?;

    let local_url = format!("http://127.0.0.1:{}/mcp", config.local_port);
    let proxy_entry_name = sanitize_toml_key(&format!("{}_local_proxy", config.name));

    // Write the TOML directly
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

    // Build the new server block (with _local_proxy suffix)
    let server_block = format!(
        "\n[mcp_servers.{}]\ncommand = \"npx\"\nargs = [\"-y\", \"mcp-remote\", \"{}\"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\n",
        proxy_entry_name, local_url
    );

    // Remove existing server block if present
    let section_header = format!("[mcp_servers.{}]", proxy_entry_name);
    if content.contains(&section_header) {
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
    fs::write(&config_path, content.trim()).map_err(|e| format!("Failed to write config: {}", e))?;

    println!(
        "[Proxy] Synced {} to Codex config: {}",
        proxy_entry_name, local_url
    );
    Ok(())
}

/// Remove proxy from Codex config
#[tauri::command]
pub fn remove_proxy_from_codex_config(proxy_name: String) -> Result<(), String> {
    // Remove using _local_proxy suffix (sanitized for TOML bare key)
    let proxy_entry_name = sanitize_toml_key(&format!("{}_local_proxy", proxy_name));
    tokio::runtime::Handle::current().block_on(async {
        remove_codex_mcp_server(proxy_entry_name).await
    })?;
    Ok(())
}

/// Sync all running proxies to both Claude and Codex configs
#[tauri::command]
pub fn sync_all_proxies_to_llm_configs(state: State<AppState>) -> Result<serde_json::Value, String> {
    let processes = state.proxy_processes.lock().map_err(|e| e.to_string())?;

    let mut synced = Vec::new();
    let mut errors = Vec::new();

    for proxy_id in processes.keys() {
        // Sync to Claude
        match sync_proxy_to_claude_config(proxy_id.clone()) {
            Ok(_) => {}
            Err(e) => errors.push(format!("Claude sync for {}: {}", proxy_id, e)),
        }

        // Sync to Codex
        match sync_proxy_to_codex_config(proxy_id.clone()) {
            Ok(_) => synced.push(proxy_id.clone()),
            Err(e) => errors.push(format!("Codex sync for {}: {}", proxy_id, e)),
        }
    }

    Ok(serde_json::json!({
        "synced": synced,
        "errors": errors
    }))
}

// ============================================================================
// Docker Management Commands (for SearXNG and other containerized services)
// ============================================================================

