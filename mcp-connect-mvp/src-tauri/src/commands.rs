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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServerConfig {
    pub id: String,
    pub name: String,
    pub url: String,
    pub transport: String,
    pub access_token: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub message_endpoint: Option<String>,
    #[serde(rename = "type")]
    pub server_type: Option<String>,
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub auto_connect: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeys {
    pub openai: Option<String>,
    pub openai_model: Option<String>,
    pub anthropic: Option<String>,
    pub anthropic_model: Option<String>,
}

pub struct AppState {
    pub api_keys: Mutex<ApiKeys>,
    pub servers: Mutex<HashMap<String, ServerConfig>>,
    pub mcp_processes: Mutex<HashMap<String, McpProcess>>,
    pub proxy_processes: Mutex<HashMap<String, ProxyProcess>>,
    pub proxy_logs: std::sync::Arc<Mutex<HashMap<String, Vec<ProxyLogEntry>>>>,
}

#[derive(Clone, serde::Serialize)]
pub struct ProxyLogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

pub struct ProxyProcess {
    pub child: Child,
    #[allow(dead_code)]
    pub config_path: String,
    pub local_port: u16,
    pub proxy_name: String,
}

impl Drop for ProxyProcess {
    fn drop(&mut self) {
        println!("[Proxy] Dropping proxy process for {} on port {}", self.proxy_name, self.local_port);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Check if a port is in use and kill any process using it
fn kill_process_on_port(port: u16) -> bool {
    use std::process::Command;

    // Try to find and kill the process using the port
    #[cfg(target_os = "linux")]
    {
        // Use fuser to find and kill the process
        let output = Command::new("fuser")
            .args(["-k", &format!("{}/tcp", port)])
            .output();

        if let Ok(output) = output {
            if output.status.success() {
                println!("[Proxy] Killed existing process on port {}", port);
                // Give it a moment to release the port
                std::thread::sleep(std::time::Duration::from_millis(500));
                return true;
            }
        }

        // Fallback: try lsof + kill
        let output = Command::new("lsof")
            .args(["-ti", &format!(":{}", port)])
            .output();

        if let Ok(output) = output {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid in pids.lines() {
                if let Ok(pid_num) = pid.trim().parse::<i32>() {
                    let _ = Command::new("kill").args(["-9", &pid_num.to_string()]).output();
                    println!("[Proxy] Killed PID {} on port {}", pid_num, port);
                }
            }
            if !pids.is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(500));
                return true;
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let output = Command::new("lsof")
            .args(["-ti", &format!(":{}", port)])
            .output();

        if let Ok(output) = output {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid in pids.lines() {
                if let Ok(pid_num) = pid.trim().parse::<i32>() {
                    let _ = Command::new("kill").args(["-9", &pid_num.to_string()]).output();
                    println!("[Proxy] Killed PID {} on port {}", pid_num, port);
                }
            }
            if !pids.is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(500));
                return true;
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Use netstat to find PID and taskkill to kill it
        let output = Command::new("netstat")
            .args(["-ano"])
            .output();

        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if line.contains(&format!(":{}", port)) && line.contains("LISTENING") {
                    if let Some(pid) = line.split_whitespace().last() {
                        let _ = Command::new("taskkill")
                            .args(["/F", "/PID", pid])
                            .output();
                        println!("[Proxy] Killed PID {} on port {}", pid, port);
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        return true;
                    }
                }
            }
        }
    }

    false
}

/// Check if a port is available
fn is_port_available(port: u16) -> bool {
    use std::net::TcpListener;
    TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

pub struct McpProcess {
    pub child: Child,
    pub stdin: Option<ChildStdin>,
    pub stdout_reader: Option<BufReader<ChildStdout>>,
}

impl Drop for McpProcess {
    fn drop(&mut self) {
        println!("[MCP] Dropping MCP process");
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            api_keys: Mutex::new(ApiKeys {
                openai: None,
                openai_model: None,
                anthropic: None,
                anthropic_model: None,
            }),
            servers: Mutex::new(HashMap::new()),
            mcp_processes: Mutex::new(HashMap::new()),
            proxy_processes: Mutex::new(HashMap::new()),
            proxy_logs: std::sync::Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

fn data_dir_file(file_name: &str) -> Option<PathBuf> {
    data_dir().map(|mut dir| {
        dir.push("kondi");
        let _ = fs::create_dir_all(&dir);
        dir.push(file_name);
        dir
    })
}

fn persist_servers_to_disk(servers: &HashMap<String, ServerConfig>) {
    if let Some(path) = data_dir_file("servers.json") {
        if let Ok(json) = serde_json::to_string_pretty(servers) {
            let _ = fs::write(path, json);
        }
    }
}

fn persist_keys_to_disk(keys: &ApiKeys) {
    if let Some(path) = data_dir_file("api_keys.json") {
        if let Ok(json) = serde_json::to_string_pretty(keys) {
            let _ = fs::write(path, json);
        }
    }
}

fn load_servers_from_disk() -> HashMap<String, ServerConfig> {
    if let Some(path) = data_dir_file("servers.json") {
        if let Ok(contents) = fs::read_to_string(path) {
            if let Ok(map) = serde_json::from_str::<HashMap<String, ServerConfig>>(&contents) {
                return map;
            }
        }
    }
    HashMap::new()
}

fn load_keys_from_disk() -> ApiKeys {
    if let Some(path) = data_dir_file("api_keys.json") {
        if let Ok(contents) = fs::read_to_string(path) {
            if let Ok(keys) = serde_json::from_str::<ApiKeys>(&contents) {
                return keys;
            }
        }
    }
    ApiKeys {
        openai: None,
        openai_model: None,
        anthropic: None,
        anthropic_model: None,
    }
}

#[tauri::command]
pub fn save_api_keys(keys: ApiKeys, state: State<AppState>) -> Result<(), String> {
    let mut current = state.api_keys.lock().map_err(|e| e.to_string())?;
    *current = keys;
    persist_keys_to_disk(&current);
    Ok(())
}

#[tauri::command]
pub fn get_api_keys(state: State<AppState>) -> Result<ApiKeys, String> {
    let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    if keys.openai.is_none() && keys.anthropic.is_none() {
        println!("[Rust] Loading API keys from disk...");
        *keys = load_keys_from_disk();
        println!(
            "[Rust] Loaded keys - anthropic present: {}",
            keys.anthropic.is_some()
        );
    }
    Ok(keys.clone())
}

#[tauri::command]
pub fn save_server_config(config: ServerConfig, state: State<AppState>) -> Result<(), String> {
    let mut servers = state.servers.lock().map_err(|e| e.to_string())?;
    servers.insert(config.id.clone(), config);
    persist_servers_to_disk(&servers);
    Ok(())
}

#[tauri::command]
pub fn get_server_configs(state: State<AppState>) -> Result<Vec<ServerConfig>, String> {
    let mut servers = state.servers.lock().map_err(|e| e.to_string())?;
    if servers.is_empty() {
        *servers = load_servers_from_disk();
    }
    Ok(servers.values().cloned().collect())
}

#[tauri::command]
pub fn delete_server_config(id: String, state: State<AppState>) -> Result<(), String> {
    let mut servers = state.servers.lock().map_err(|e| e.to_string())?;
    servers.remove(&id);
    persist_servers_to_disk(&servers);
    Ok(())
}

#[tauri::command]
pub fn save_chats(chats: String) -> Result<(), String> {
    if let Some(path) = data_dir_file("chats.json") {
        fs::write(path, chats).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GithubReadmeRequest {
    pub repo_url: String,
    pub reference: Option<String>,
}

#[tauri::command]
pub async fn fetch_github_readme(request: GithubReadmeRequest) -> Result<String, String> {
    let parsed = Url::parse(&request.repo_url).map_err(|e| format!("Invalid repo URL: {}", e))?;
    if parsed.host_str().unwrap_or_default() != "github.com" {
        return Err("Only github.com repositories are supported for README fetch".into());
    }

    let segments: Vec<&str> = parsed.path().trim_matches('/').split('/').collect();
    if segments.len() < 2 {
        return Err("Repo URL must be in the form https://github.com/owner/repo".into());
    }
    let owner = segments[0];
    let repo = segments[1];

    let reference = if segments.len() >= 4 && segments[2] == "tree" {
        segments[3].to_string()
    } else {
        request.reference.clone().unwrap_or_else(|| "main".into())
    };

    let raw_base = format!("https://raw.githubusercontent.com/{}/{}/{}", owner, repo, reference);
    let candidates = vec![
        "README.md",
        "readme.md",
        "Readme.md",
        "README.MD",
    ];

    let client = reqwest::Client::new();
    for path in candidates {
        let url = format!("{}/{}", raw_base, path);
        let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            let text = resp.text().await.map_err(|e| e.to_string())?;
            if text.len() > 512 * 1024 {
                return Err("README exceeds size limit".into());
            }
            return Ok(text);
        }
    }

    Err("README not found (tried README.md variants)".into())
}

#[tauri::command]
pub fn load_chats() -> Result<Option<String>, String> {
    if let Some(path) = data_dir_file("chats.json") {
        if path.exists() {
            let contents = fs::read_to_string(path).map_err(|e| e.to_string())?;
            return Ok(Some(contents));
        }
    }
    Ok(None)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GithubManifestRequest {
    pub repo_url: String,
    pub reference: Option<String>,
    pub manifest_path: Option<String>,
}

#[tauri::command]
pub async fn fetch_github_manifest(request: GithubManifestRequest) -> Result<String, String> {
    // Only allow github.com
    let parsed = Url::parse(&request.repo_url).map_err(|e| format!("Invalid repo URL: {}", e))?;
    if parsed.host_str().unwrap_or_default() != "github.com" {
        return Err("Only github.com repositories are supported for manifest fetch".into());
    }

    // Extract owner/repo and ref/path
    let segments: Vec<&str> = parsed.path().trim_matches('/').split('/').collect();
    if segments.len() < 2 {
        return Err("Repo URL must be in the form https://github.com/owner/repo".into());
    }
    let owner = segments[0];
    let repo = segments[1];

    // Determine ref and manifest path - honor URL if it contains tree/<ref>/...
    let (reference, manifest_path) = if segments.len() >= 4 && segments[2] == "tree" {
        let git_ref = segments[3].to_string();
        let path = if segments.len() > 4 {
            segments[4..].join("/")
        } else {
            request.manifest_path.clone().unwrap_or_else(|| "kondi-mcp.json".into())
        };
        (git_ref, path)
    } else {
        (
            request.reference.clone().unwrap_or_else(|| "main".into()),
            request.manifest_path.clone().unwrap_or_else(|| "kondi-mcp.json".into()),
        )
    };

    // Build raw URL
    let raw_base = format!("https://raw.githubusercontent.com/{}/{}/{}", owner, repo, reference);

    // First try dedicated manifest files
    let manifest_candidates = vec![
        manifest_path.clone(),
        "kondi-mcp.json".to_string(),
        "mcp.json".to_string(),
        "manifest.json".to_string(),
    ];

    let client = reqwest::Client::new();
    for path in manifest_candidates {
        let url = format!("{}/{}", raw_base, path);
        let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            let text = resp.text().await.map_err(|e| e.to_string())?;
            if text.len() > 256 * 1024 {
                return Err("Manifest exceeds size limit".into());
            }
            // Validate JSON parses
            serde_json::from_str::<serde_json::Value>(&text).map_err(|e| format!("Invalid JSON: {}", e))?;
            return Ok(text);
        }
    }

    // Fall back to package.json (Node.js) and create a synthetic manifest
    let package_url = format!("{}/package.json", raw_base);
    let resp = client.get(&package_url).send().await.map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        let text = resp.text().await.map_err(|e| e.to_string())?;
        let pkg: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Invalid package.json: {}", e))?;

        // Extract entrypoint from package.json
        // Priority: bin (if object, take first value or "index.js"), main, or default to "index.js"
        let entrypoint = if let Some(bin) = pkg.get("bin") {
            if let Some(bin_str) = bin.as_str() {
                bin_str.to_string()
            } else if let Some(bin_obj) = bin.as_object() {
                bin_obj.values().next()
                    .and_then(|v| v.as_str())
                    .unwrap_or("index.js")
                    .to_string()
            } else {
                "index.js".to_string()
            }
        } else if let Some(main) = pkg.get("main").and_then(|m| m.as_str()) {
            main.to_string()
        } else {
            "index.js".to_string()
        };

        // Create synthetic manifest from package.json
        let manifest = serde_json::json!({
            "name": pkg.get("name").and_then(|n| n.as_str()).unwrap_or("mcp-server"),
            "version": pkg.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0"),
            "description": pkg.get("description").and_then(|d| d.as_str()).unwrap_or(""),
            "runtime": "node",
            "package": {
                "version": pkg.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0"),
                "manager": "npm"
            },
            "run": {
                "command": "node",
                "args": [entrypoint]
            },
            "_source": "package.json"
        });

        return Ok(manifest.to_string());
    }

    // Fall back to pyproject.toml (Python) and create a synthetic manifest
    let pyproject_url = format!("{}/pyproject.toml", raw_base);
    let resp = client.get(&pyproject_url).send().await.map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        let text = resp.text().await.map_err(|e| e.to_string())?;

        // Parse pyproject.toml to extract name, version, and scripts
        // This is a simplified parser - just extract key fields
        let mut name = "mcp-server".to_string();
        let mut version = "0.0.0".to_string();
        let mut description = String::new();
        let mut package_manager = "pip".to_string();

        // Check for uv.lock to determine package manager
        let uv_lock_url = format!("{}/uv.lock", raw_base);
        if let Ok(uv_resp) = client.get(&uv_lock_url).send().await {
            if uv_resp.status().is_success() {
                package_manager = "uv".to_string();
            }
        }

        // Simple TOML parsing for key fields
        let mut in_project = false;
        for line in text.lines() {
            let line = line.trim();
            if line == "[project]" {
                in_project = true;
            } else if line.starts_with('[') {
                in_project = false;
            } else if in_project {
                if let Some(val) = line.strip_prefix("name = ") {
                    name = val.trim_matches('"').to_string();
                } else if let Some(val) = line.strip_prefix("version = ") {
                    version = val.trim_matches('"').to_string();
                } else if let Some(val) = line.strip_prefix("description = ") {
                    description = val.trim_matches('"').to_string();
                }
            }
        }

        // Build module name from package name (replace hyphens with underscores)
        let module_name = name.replace('-', "_");

        let manifest = serde_json::json!({
            "name": name,
            "version": version,
            "description": description,
            "runtime": "python",
            "package": {
                "version": version,
                "manager": package_manager
            },
            "run": {
                // Use system python with PYTHONPATH set to local .lib directory
                "command": "python",  // Will be resolved to python3 at runtime
                "args": ["-m", module_name],
                "env": {
                    "PYTHONPATH": ".lib"
                }
            },
            "_source": "pyproject.toml"
        });

        return Ok(manifest.to_string());
    }

    Err("No manifest found. Tried kondi-mcp.json, mcp.json, manifest.json, package.json, and pyproject.toml".into())
}

#[tauri::command]
pub async fn start_oauth(
    _app: tauri::AppHandle,
    server_url: String,
    client_id: Option<String>,
    client_secret: Option<String>,
) -> Result<String, String> {
    // Derive OAuth endpoints from base server URL
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

    // Discover well-known endpoints
    let well_known_url = format!("{}/.well-known/oauth-authorization-server", base_with_port);
    let mut authorization_endpoint = format!("{}/oauth/authorize", base_with_port);
    let mut token_endpoint = format!("{}/oauth/token", base_with_port);
    let mut registration_endpoint: Option<String> = None;

    if let Ok(res) = reqwest::Client::new().get(&well_known_url).send().await {
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

    let callback_port = 9876;
    let redirect_uri = format!("http://localhost:{}/callback", callback_port);
    let port = callback_port;

    let code_verifier: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect();
    let challenge_bytes = Sha256::digest(code_verifier.as_bytes());
    let code_challenge = URL_SAFE_NO_PAD.encode(challenge_bytes);
    let state: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(16)
        .map(char::from)
        .collect();

    // Register client dynamically if none provided
    let mut client_id_final = client_id.clone();
    let mut client_secret_final = client_secret.clone();

    if client_id_final.is_none() {
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
        let client = reqwest::Client::new();
        let res = client
            .post(&reg_url)
            .json(&reg_body)
            .send()
            .await
            .map_err(|e| format!("Dynamic client registration failed: {}", e))?;
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(format!(
                "Dynamic client registration failed at {}: HTTP {} {}. This provider likely requires a pre-registered client_id/client_secret; please enter them manually and try again.",
                reg_url, status, text
            ));
        }
        let reg_json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        client_id_final = reg_json
            .get("client_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        client_secret_final = reg_json
            .get("client_secret")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if client_id_final.is_none() {
            return Err("Dynamic registration did not return client_id".into());
        }
    }

    let mut authorize_url = Url::parse(&authorization_endpoint).map_err(|e| e.to_string())?;
    {
        let mut pairs = authorize_url.query_pairs_mut();
        if let Some(id) = &client_id_final {
            pairs.append_pair("client_id", id);
        }
        pairs
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("code_challenge", &code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state);
    }

    let _ = webbrowser::open(authorize_url.as_str());

    let (tx, rx) = tokio::sync::oneshot::channel::<(String, String)>();

    std::thread::spawn(move || {
        if let Ok(server) = tiny_http::Server::http(format!("127.0.0.1:{}", port)) {
            // Handle multiple requests until we get the OAuth callback with code
            // This handles favicon requests, preflight requests, etc.
            for request in server.incoming_requests() {
                let url_str = format!("http://localhost:{}{}", port, request.url());

                // Skip non-callback requests (favicon, etc.)
                if !request.url().starts_with("/callback") {
                    let _ = request.respond(Response::from_string(""));
                    continue;
                }

                if let Ok(parsed) = Url::parse(&url_str) {
                    let code = parsed
                        .query_pairs()
                        .find(|(k, _)| k == "code")
                        .map(|(_, v)| v.to_string());
                    let returned_state = parsed
                        .query_pairs()
                        .find(|(k, _)| k == "state")
                        .map(|(_, v)| v.to_string());

                    if let (Some(c), Some(s)) = (code, returned_state) {
                        let _ = tx.send((c.clone(), s.clone()));
                        let _ = request.respond(Response::from_string(
                            "Authentication successful! You can close this window and return to the app.",
                        ));
                        break; // Exit after successful callback
                    }
                }

                // Callback without code - might be an error
                let _ = request.respond(Response::from_string("Invalid OAuth response - missing code"));
                break;
            }
        }
    });

    // Wait for callback with 5 minute timeout — users may need time to
    // log in, approve permissions, or complete MFA in the browser.
    let (code, returned_state) = tokio::time::timeout(
        std::time::Duration::from_secs(300),
        rx
    )
    .await
    .map_err(|_| "OAuth timed out after 5 minutes. Please try again.")?
    .map_err(|e| e.to_string())?;
    if returned_state != state {
        return Err("OAuth state mismatch".into());
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(&token_endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body({
            let mut params = vec![
                ("grant_type", "authorization_code".to_string()),
                ("code", code.clone()),
                ("redirect_uri", redirect_uri.clone()),
                ("code_verifier", code_verifier.clone()),
            ];
            if let Some(id) = &client_id_final {
                params.push(("client_id", id.clone()));
            }
            if let Some(secret) = &client_secret_final {
                params.push(("client_secret", secret.clone()));
            }
            params
                .iter()
                .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
                .collect::<Vec<String>>()
                .join("&")
        })
        .send()
        .await
        .map_err(|e| format!("Failed to reach token endpoint {}: {}", token_endpoint, e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Token exchange failed at {} ({}): {}",
            token_endpoint, status, text
        ));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let access_token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "No access_token in response".to_string())?;

    Ok(access_token.to_string())
}

/// OAuth result with all credentials needed for token management
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthResult {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>,
    pub client_id: String,
    pub client_secret: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
}

/// Internal OAuth function that returns full credentials
/// Used by reauthenticate_proxy to get all OAuth details in one call
/// callback_port: if Some, use that port for the OAuth callback server; otherwise pick 9876
pub async fn start_oauth_full(
    server_url: String,
    callback_port: Option<u16>,
) -> Result<OAuthResult, String> {
    // Derive OAuth endpoints from base server URL
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

    // Discover well-known endpoints
    let well_known_url = format!("{}/.well-known/oauth-authorization-server", base_with_port);
    let mut authorization_endpoint = format!("{}/oauth/authorize", base_with_port);
    let mut token_endpoint = format!("{}/oauth/token", base_with_port);
    let mut registration_endpoint: Option<String> = None;

    println!("[OAuth Full] Discovering endpoints from {}", well_known_url);
    if let Ok(res) = reqwest::Client::new().get(&well_known_url).send().await {
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

    let cb_port = callback_port.unwrap_or(9876);
    let redirect_uri = format!("http://localhost:{}/callback", cb_port);
    let port = cb_port;
    println!("[OAuth Full] Using callback port: {}", port);

    let code_verifier: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect();
    let challenge_bytes = Sha256::digest(code_verifier.as_bytes());
    let code_challenge = URL_SAFE_NO_PAD.encode(challenge_bytes);
    let state: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(16)
        .map(char::from)
        .collect();

    // Always do dynamic client registration
    let reg_url = registration_endpoint
        .unwrap_or_else(|| format!("{}/oauth/register", base_with_port));
    println!("[OAuth] Registering new client at {}", reg_url);

    let reg_body = serde_json::json!({
        "redirect_uris": [redirect_uri],
        "client_name": "Kondi",
        "grant_types": ["authorization_code"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "client_secret_post"
    });
    let client = reqwest::Client::new();
    let res = client
        .post(&reg_url)
        .json(&reg_body)
        .send()
        .await
        .map_err(|e| format!("Dynamic client registration failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!(
            "Dynamic client registration failed at {}: HTTP {} {}",
            reg_url, status, text
        ));
    }

    let reg_json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let client_id = reg_json
        .get("client_id")
        .and_then(|v| v.as_str())
        .ok_or("Dynamic registration did not return client_id")?
        .to_string();
    let client_secret = reg_json
        .get("client_secret")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    println!("[OAuth] Registered new client_id: {}", client_id);

    let mut authorize_url = Url::parse(&authorization_endpoint).map_err(|e| e.to_string())?;
    {
        let mut pairs = authorize_url.query_pairs_mut();
        pairs
            .append_pair("client_id", &client_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("code_challenge", &code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("scope", "openid profile offline_access");
    }

    println!("[OAuth] Opening browser for authorization");
    let _ = webbrowser::open(authorize_url.as_str());

    let (tx, rx) = tokio::sync::oneshot::channel::<(String, String)>();

    std::thread::spawn(move || {
        if let Ok(server) = tiny_http::Server::http(format!("127.0.0.1:{}", port)) {
            for request in server.incoming_requests() {
                let url_str = format!("http://localhost:{}{}", port, request.url());

                if !request.url().starts_with("/callback") {
                    let _ = request.respond(Response::from_string(""));
                    continue;
                }

                if let Ok(parsed) = Url::parse(&url_str) {
                    let code = parsed
                        .query_pairs()
                        .find(|(k, _)| k == "code")
                        .map(|(_, v)| v.to_string());
                    let returned_state = parsed
                        .query_pairs()
                        .find(|(k, _)| k == "state")
                        .map(|(_, v)| v.to_string());

                    if let (Some(c), Some(s)) = (code, returned_state) {
                        let _ = tx.send((c.clone(), s.clone()));
                        let _ = request.respond(Response::from_string(
                            "Authentication successful! You can close this window and return to the app.",
                        ));
                        break;
                    }
                }

                let _ = request.respond(Response::from_string("Invalid OAuth response - missing code"));
                break;
            }
        }
    });

    // Wait for callback with 5 minute timeout — users may need time to
    // log in, approve permissions, or complete MFA in the browser.
    let (code, returned_state) = tokio::time::timeout(
        std::time::Duration::from_secs(300),
        rx
    )
    .await
    .map_err(|_| "OAuth timed out after 5 minutes. Please try again.")?
    .map_err(|e| e.to_string())?;

    if returned_state != state {
        return Err("OAuth state mismatch".into());
    }

    println!("[OAuth] Exchanging code for token");
    let client = reqwest::Client::new();
    let resp = client
        .post(&token_endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body({
            let mut params = vec![
                ("grant_type", "authorization_code".to_string()),
                ("code", code.clone()),
                ("redirect_uri", redirect_uri.clone()),
                ("code_verifier", code_verifier.clone()),
                ("client_id", client_id.clone()),
            ];
            if !client_secret.is_empty() {
                params.push(("client_secret", client_secret.clone()));
            }
            params
                .iter()
                .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
                .collect::<Vec<String>>()
                .join("&")
        })
        .send()
        .await
        .map_err(|e| format!("Failed to reach token endpoint {}: {}", token_endpoint, e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Token exchange failed at {} ({}): {}",
            token_endpoint, status, text
        ));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let access_token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "No access_token in response".to_string())?
        .to_string();
    let refresh_token = json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Calculate expires_at from expires_in (seconds from now)
    let expires_at = json
        .get("expires_in")
        .and_then(|v| v.as_i64())
        .map(|expires_in| chrono::Utc::now().timestamp() + expires_in);

    println!("[OAuth] Successfully obtained access token (expires_at: {:?})", expires_at);

    Ok(OAuthResult {
        access_token,
        refresh_token,
        expires_at,
        client_id,
        client_secret,
        authorization_endpoint,
        token_endpoint,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpResponse {
    pub body: String,
    pub session_id: Option<String>,
    pub content_type: Option<String>,
}

#[tauri::command]
pub async fn mcp_request(
    url: String,
    method: String,
    body: Option<String>,
    access_token: Option<String>,
    session_id: Option<String>,
) -> Result<McpResponse, String> {
    let client = reqwest::Client::new();

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
) -> Result<String, String> {
    let client = reqwest::Client::new();

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

    if is_oauth_token {
        // OAuth token: use Authorization Bearer header
        request = request.header("Authorization", format!("Bearer {}", apiKey));

        // REQUIRED: Add beta header to enable OAuth authentication
        request = request.header("anthropic-beta", "oauth-2025-04-20");
    } else {
        // API key: use x-api-key header
        request = request.header("x-api-key", &apiKey);
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
// Local File System Tools
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>,
}

#[tauri::command]
pub async fn read_local_file(path: String) -> Result<String, String> {
    use std::path::Path;

    let file_path = Path::new(&path);

    // Security: Don't allow reading sensitive system files
    let path_str = file_path.to_string_lossy().to_lowercase();
    if path_str.contains("/.ssh/") ||
       path_str.contains("/etc/shadow") ||
       path_str.contains("/etc/passwd") ||
       path_str.contains(".env") && !path_str.ends_with(".env.example") {
        return Err("Access to sensitive files is not allowed".to_string());
    }

    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    if !file_path.is_file() {
        return Err(format!("Path is not a file: {}", path));
    }

    // Check file size - limit to 10MB for text files
    let metadata = fs::metadata(file_path).map_err(|e| e.to_string())?;
    if metadata.len() > 10 * 1024 * 1024 {
        return Err("File is too large (max 10MB)".to_string());
    }

    fs::read_to_string(file_path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
pub async fn write_local_file(path: String, content: String) -> Result<(), String> {
    use std::path::Path;

    let file_path = Path::new(&path);

    // Security: Don't allow writing to sensitive locations
    let path_str = file_path.to_string_lossy().to_lowercase();
    if path_str.contains("/.ssh/") ||
       path_str.starts_with("/etc/") ||
       path_str.starts_with("/usr/") ||
       path_str.starts_with("/bin/") ||
       path_str.starts_with("/sbin/") {
        return Err("Writing to system directories is not allowed".to_string());
    }

    // Create parent directories if they don't exist
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    fs::write(file_path, content).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<FileInfo>, String> {
    use std::path::Path;
    use std::time::UNIX_EPOCH;

    let dir_path = Path::new(&path);

    // Security: Don't allow listing sensitive directories
    let path_str = dir_path.to_string_lossy().to_lowercase();
    if path_str.contains("/.ssh") ||
       path_str == "/etc" ||
       path_str.starts_with("/etc/") {
        return Err("Access to sensitive directories is not allowed".to_string());
    }

    if !dir_path.exists() {
        return Err(format!("Directory not found: {}", path));
    }

    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut entries = Vec::new();

    let read_dir = fs::read_dir(dir_path).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;

        let modified = metadata.modified().ok().and_then(|time| {
            time.duration_since(UNIX_EPOCH).ok().map(|d| {
                let secs = d.as_secs();
                // Format as ISO 8601
                let datetime = chrono::DateTime::from_timestamp(secs as i64, 0);
                datetime.map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
            }).flatten()
        });

        entries.push(FileInfo {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified,
        });
    }

    // Sort: directories first, then by name
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

#[tauri::command]
pub async fn get_home_directory() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

/// Check if a path is within the allowed working directory
#[tauri::command]
pub async fn is_path_in_scope(path: String, working_dir: String) -> Result<bool, String> {
    use std::path::Path;

    let target = Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;
    let scope = Path::new(&working_dir)
        .canonicalize()
        .map_err(|e| format!("Invalid working directory: {}", e))?;

    Ok(target.starts_with(&scope))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub success: bool,
}

/// Run a command in the specified working directory
#[tauri::command]
pub async fn run_command(
    command: String,
    working_dir: String,
) -> Result<CommandOutput, String> {
    use std::path::Path;

    let dir_path = Path::new(&working_dir);

    if !dir_path.exists() {
        return Err(format!("Working directory does not exist: {}", working_dir));
    }

    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", working_dir));
    }

    // Security: Block obviously dangerous commands
    let cmd_lower = command.to_lowercase();
    let dangerous_patterns = [
        "rm -rf /",
        "rm -rf ~",
        "sudo rm",
        "mkfs",
        "dd if=",
        ":(){:|:&};:",
        "chmod -r 777 /",
        "curl | sh",
        "wget | sh",
    ];

    for pattern in &dangerous_patterns {
        if cmd_lower.contains(pattern) {
            return Err(format!("Blocked dangerous command pattern: {}", pattern));
        }
    }

    // Run the command using sh -c to support pipes and complex commands
    let output = StdCommand::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(dir_path)
        .output()
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);

    Ok(CommandOutput {
        stdout,
        stderr,
        exit_code,
        success: output.status.success(),
    })
}

// ============================================================================
// GitHub Sidecar / Subprocess Management
// ============================================================================

fn mcp_servers_dir() -> Option<PathBuf> {
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AllCLICredentials {
    pub codex: CLICredentialInfo,
    pub claude: CLICredentialInfo,
    pub gemini: CLICredentialInfo,
    pub qwen: CLICredentialInfo,
    pub minimax: CLICredentialInfo,
}

/// Check for CLI OAuth credentials from various tools
#[tauri::command]
pub fn check_cli_credentials() -> Result<AllCLICredentials, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;

    // Check Codex CLI (~/.codex/auth.json)
    let codex = check_codex_credentials(&home);

    // Check Claude CLI (~/.claude/.credentials.json)
    let claude = check_claude_credentials(&home);

    // Check Gemini CLI (~/.gemini/oauth_creds.json)
    let gemini = check_gemini_credentials(&home);

    // Check Qwen CLI (~/.qwen/oauth_creds.json)
    let qwen = check_qwen_credentials(&home);

    // Check MiniMax CLI (~/.minimax/oauth_creds.json)
    let minimax = check_minimax_credentials(&home);

    Ok(AllCLICredentials {
        codex,
        claude,
        gemini,
        qwen,
        minimax,
    })
}

fn check_codex_credentials(home: &PathBuf) -> CLICredentialInfo {
    let auth_path = home.join(".codex").join("auth.json");

    match fs::read_to_string(&auth_path) {
        Ok(content) => {
            match serde_json::from_str::<serde_json::Value>(&content) {
                Ok(json) => {
                    let tokens = json.get("tokens");
                    let has_access = tokens
                        .and_then(|t| t.get("access_token"))
                        .and_then(|v| v.as_str())
                        .is_some();
                    let has_refresh = tokens
                        .and_then(|t| t.get("refresh_token"))
                        .and_then(|v| v.as_str())
                        .is_some();

                    if has_access && has_refresh {
                        // Get expiry if available
                        let expires_at = json.get("expires_at")
                            .and_then(|v| v.as_str())
                            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                            .map(|dt| dt.timestamp_millis());

                        CLICredentialInfo {
                            available: true,
                            expires_at,
                            error: None,
                        }
                    } else {
                        CLICredentialInfo {
                            available: false,
                            expires_at: None,
                            error: Some("No tokens found in auth.json".to_string()),
                        }
                    }
                }
                Err(e) => CLICredentialInfo {
                    available: false,
                    expires_at: None,
                    error: Some(format!("Invalid JSON: {}", e)),
                },
            }
        }
        Err(_) => CLICredentialInfo {
            available: false,
            expires_at: None,
            error: None, // File doesn't exist is not an error
        },
    }
}

fn check_claude_credentials(home: &PathBuf) -> CLICredentialInfo {
    let cred_path = home.join(".claude").join(".credentials.json");

    match fs::read_to_string(&cred_path) {
        Ok(content) => {
            match serde_json::from_str::<serde_json::Value>(&content) {
                Ok(json) => {
                    // Check for OAuth credentials
                    if let Some(oauth) = json.get("claudeAiOauth") {
                        let has_access = oauth.get("accessToken").and_then(|v| v.as_str()).is_some();
                        let has_refresh = oauth.get("refreshToken").and_then(|v| v.as_str()).is_some();

                        if has_access && has_refresh {
                            let expires_at = oauth.get("expiresAt")
                                .and_then(|v| v.as_str())
                                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                                .map(|dt| dt.timestamp_millis());

                            return CLICredentialInfo {
                                available: true,
                                expires_at,
                                error: None,
                            };
                        }
                    }

                    // Check for API key
                    if json.get("apiKey").and_then(|v| v.as_str()).is_some() {
                        return CLICredentialInfo {
                            available: true,
                            expires_at: None,
                            error: None,
                        };
                    }

                    CLICredentialInfo {
                        available: false,
                        expires_at: None,
                        error: Some("No credentials found".to_string()),
                    }
                }
                Err(e) => CLICredentialInfo {
                    available: false,
                    expires_at: None,
                    error: Some(format!("Invalid JSON: {}", e)),
                },
            }
        }
        Err(_) => CLICredentialInfo {
            available: false,
            expires_at: None,
            error: None,
        },
    }
}

fn check_gemini_credentials(home: &PathBuf) -> CLICredentialInfo {
    let cred_path = home.join(".gemini").join("oauth_creds.json");
    check_oauth_file(&cred_path)
}

fn check_qwen_credentials(home: &PathBuf) -> CLICredentialInfo {
    let cred_path = home.join(".qwen").join("oauth_creds.json");
    check_oauth_file(&cred_path)
}

fn check_minimax_credentials(home: &PathBuf) -> CLICredentialInfo {
    let cred_path = home.join(".minimax").join("oauth_creds.json");
    check_oauth_file(&cred_path)
}

fn check_oauth_file(path: &PathBuf) -> CLICredentialInfo {
    match fs::read_to_string(path) {
        Ok(content) => {
            match serde_json::from_str::<serde_json::Value>(&content) {
                Ok(json) => {
                    let has_access = json.get("access_token").and_then(|v| v.as_str()).is_some();
                    let has_refresh = json.get("refresh_token").and_then(|v| v.as_str()).is_some();

                    if has_access && has_refresh {
                        // Try to parse expires_at (could be number or string)
                        let expires_at = json.get("expires_at")
                            .and_then(|v| {
                                if let Some(n) = v.as_i64() {
                                    Some(n * 1000) // Convert seconds to ms
                                } else if let Some(s) = v.as_str() {
                                    chrono::DateTime::parse_from_rfc3339(s)
                                        .ok()
                                        .map(|dt| dt.timestamp_millis())
                                } else {
                                    None
                                }
                            });

                        CLICredentialInfo {
                            available: true,
                            expires_at,
                            error: None,
                        }
                    } else {
                        CLICredentialInfo {
                            available: false,
                            expires_at: None,
                            error: Some("Missing access_token or refresh_token".to_string()),
                        }
                    }
                }
                Err(e) => CLICredentialInfo {
                    available: false,
                    expires_at: None,
                    error: Some(format!("Invalid JSON: {}", e)),
                },
            }
        }
        Err(_) => CLICredentialInfo {
            available: false,
            expires_at: None,
            error: None,
        },
    }
}

/// Get the OAuth token for a specific CLI tool
#[tauri::command]
pub fn get_cli_token(cli_tool: String) -> Result<Option<String>, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;

    match cli_tool.as_str() {
        "codex" => {
            let auth_path = home.join(".codex").join("auth.json");
            if let Ok(content) = fs::read_to_string(&auth_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    return Ok(json.get("tokens")
                        .and_then(|t| t.get("access_token"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()));
                }
            }
            Ok(None)
        }
        "claude" => {
            let cred_path = home.join(".claude").join(".credentials.json");
            if let Ok(content) = fs::read_to_string(&cred_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    // Try OAuth first
                    if let Some(token) = json.get("claudeAiOauth")
                        .and_then(|o| o.get("accessToken"))
                        .and_then(|v| v.as_str()) {
                        return Ok(Some(token.to_string()));
                    }
                    // Fall back to API key
                    if let Some(key) = json.get("apiKey").and_then(|v| v.as_str()) {
                        return Ok(Some(key.to_string()));
                    }
                }
            }
            Ok(None)
        }
        "gemini" => get_oauth_token(&home.join(".gemini").join("oauth_creds.json")),
        "qwen" => get_oauth_token(&home.join(".qwen").join("oauth_creds.json")),
        "minimax" => get_oauth_token(&home.join(".minimax").join("oauth_creds.json")),
        _ => Err(format!("Unknown CLI tool: {}", cli_tool)),
    }
}

fn get_oauth_token(path: &PathBuf) -> Result<Option<String>, String> {
    if let Ok(content) = fs::read_to_string(path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            return Ok(json.get("access_token")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()));
        }
    }
    Ok(None)
}

/// Run CLI login command for a provider
#[tauri::command]
pub async fn run_cli_login(cli_tool: String) -> Result<bool, String> {
    let login_cmd = match cli_tool.as_str() {
        "claude" => "claude login",
        "codex" => "codex login",
        "gemini" => "gemini auth login",
        "qwen" => "qwen auth login",
        "minimax" => "minimax auth login",
        _ => return Err(format!("Unknown CLI tool: {}", cli_tool)),
    };

    // Try different terminal emulators
    let terminals = [
        ("gnome-terminal", vec!["--", "bash", "-c"]),
        ("konsole", vec!["-e", "bash", "-c"]),
        ("xfce4-terminal", vec!["-e", "bash -c"]),
        ("xterm", vec!["-e", "bash", "-c"]),
        ("alacritty", vec!["-e", "bash", "-c"]),
        ("kitty", vec!["bash", "-c"]),
        ("wezterm", vec!["start", "--", "bash", "-c"]),
    ];

    // Command that runs login and waits for user to press enter
    let full_cmd = format!("{}; echo ''; echo 'Press Enter to close...'; read", login_cmd);

    for (terminal, args) in terminals.iter() {
        // Check if terminal exists
        if let Ok(output) = std::process::Command::new("which")
            .arg(terminal)
            .output()
        {
            if output.status.success() {
                let mut cmd = std::process::Command::new(terminal);
                for arg in args {
                    cmd.arg(arg);
                }
                cmd.arg(&full_cmd);

                match cmd.spawn() {
                    Ok(_) => {
                        println!("[run_cli_login] Spawned {} with: {}", terminal, login_cmd);
                        return Ok(true);
                    }
                    Err(e) => {
                        println!("[run_cli_login] Failed to spawn {}: {}", terminal, e);
                        continue;
                    }
                }
            }
        }
    }

    // Fallback: try running directly (might work in some environments)
    Err("Could not find a terminal emulator. Please run the login command manually in your terminal.".to_string())
}

// ============================================================================
// LLM Provider OAuth (Anthropic Claude & OpenAI Codex)
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub token_type: String,
    pub provider: String,
}

// Anthropic OAuth Constants
const ANTHROPIC_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_AUTH_ENDPOINT: &str = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_ENDPOINT: &str = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_REDIRECT_URI: &str = "https://console.anthropic.com/oauth/code/callback";
const ANTHROPIC_SCOPES: &str = "org:create_api_key user:profile user:inference";

// OpenAI OAuth Constants
const OPENAI_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_AUTH_ENDPOINT: &str = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_ENDPOINT: &str = "https://auth.openai.com/oauth/token";
const OPENAI_CALLBACK_PORT: u16 = 1455;
const OPENAI_SCOPES: &str = "openid profile email offline_access";

/// OAuth session data returned to frontend for code-paste flow
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthSession {
    pub auth_url: String,
    pub code_verifier: String,
    pub state: String,
}

/// Start Anthropic OAuth flow - returns session info and opens browser
/// User will need to copy the auth code from the redirect page
#[tauri::command]
pub async fn start_anthropic_oauth() -> Result<OAuthSession, String> {
    // Generate PKCE
    let code_verifier: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect();
    let challenge_bytes = Sha256::digest(code_verifier.as_bytes());
    let code_challenge = URL_SAFE_NO_PAD.encode(challenge_bytes);

    // Generate state for CSRF protection
    let state: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();

    // Build authorization URL with console redirect (for code copy-paste flow)
    let auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        ANTHROPIC_AUTH_ENDPOINT,
        ANTHROPIC_CLIENT_ID,
        urlencoding::encode(ANTHROPIC_REDIRECT_URI),
        urlencoding::encode(ANTHROPIC_SCOPES),
        code_challenge,
        state
    );

    println!("[Anthropic OAuth] Starting OAuth flow (code-paste mode)...");
    println!("[Anthropic OAuth] Auth URL: {}", auth_url);

    // Open browser for user to authorize
    if let Err(e) = webbrowser::open(&auth_url) {
        println!("[Anthropic OAuth] Failed to open browser: {}. Please open this URL manually: {}", e, auth_url);
    }

    // Return session info - frontend will prompt user to paste the code
    Ok(OAuthSession {
        auth_url,
        code_verifier,
        state,
    })
}

/// Exchange Anthropic auth code for tokens (second step of OAuth flow)
#[tauri::command]
pub async fn exchange_anthropic_code(code: String, code_verifier: String, state: String) -> Result<OAuthTokens, String> {
    println!("[Anthropic OAuth] Exchanging code for tokens...");
    println!("[Anthropic OAuth] Code: {}...", &code[..std::cmp::min(20, code.len())]);

    // Handle Anthropic's quirky code#state format
    let actual_code = if code.contains('#') {
        code.split('#').next().unwrap_or(&code).to_string()
    } else {
        code.trim().to_string()
    };

    // Exchange code for tokens (Anthropic uses JSON body)
    let client = reqwest::Client::new();
    let token_body = serde_json::json!({
        "grant_type": "authorization_code",
        "code": actual_code,
        "state": state,
        "redirect_uri": ANTHROPIC_REDIRECT_URI,
        "client_id": ANTHROPIC_CLIENT_ID,
        "code_verifier": code_verifier
    });

    let resp = client
        .post(ANTHROPIC_TOKEN_ENDPOINT)
        .header("Content-Type", "application/json")
        .json(&token_body)
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Anthropic token exchange failed: HTTP {} - {}", status, text));
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

    // Anthropic may return expires_at (absolute) or expires_in (relative)
    let expires_at = token_json
        .get("expires_at")
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| {
            let expires_in = token_json
                .get("expires_in")
                .and_then(|v| v.as_i64())
                .unwrap_or(28800); // Default 8 hours
            chrono::Utc::now().timestamp_millis() + (expires_in * 1000)
        });

    println!("[Anthropic OAuth] Successfully obtained tokens!");

    Ok(OAuthTokens {
        access_token,
        refresh_token,
        expires_at,
        token_type: "Bearer".to_string(),
        provider: "anthropic".to_string(),
    })
}

/// Refresh Anthropic OAuth token
#[tauri::command]
pub async fn refresh_anthropic_token(refresh_token: String) -> Result<OAuthTokens, String> {
    let client = reqwest::Client::new();
    let token_body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": ANTHROPIC_CLIENT_ID
    });

    let resp = client
        .post(ANTHROPIC_TOKEN_ENDPOINT)
        .header("Content-Type", "application/json")
        .json(&token_body)
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Anthropic token refresh failed: HTTP {} - {}", status, text));
    }

    let token_json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let access_token = token_json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("No access_token in response")?
        .to_string();

    let new_refresh_token = token_json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or(refresh_token);

    let expires_at = token_json
        .get("expires_at")
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| {
            let expires_in = token_json
                .get("expires_in")
                .and_then(|v| v.as_i64())
                .unwrap_or(28800);
            chrono::Utc::now().timestamp_millis() + (expires_in * 1000)
        });

    Ok(OAuthTokens {
        access_token,
        refresh_token: new_refresh_token,
        expires_at,
        token_type: "Bearer".to_string(),
        provider: "anthropic".to_string(),
    })
}

/// Start OpenAI OAuth flow and return tokens
#[tauri::command]
pub async fn start_openai_oauth() -> Result<OAuthTokens, String> {
    let redirect_uri = format!("http://localhost:{}/callback", OPENAI_CALLBACK_PORT);

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

    // Build authorization URL
    let auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        OPENAI_AUTH_ENDPOINT,
        OPENAI_CLIENT_ID,
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(OPENAI_SCOPES),
        code_challenge,
        state
    );

    println!("[OpenAI OAuth] Starting OAuth flow...");
    println!("[OpenAI OAuth] Auth URL: {}", auth_url);

    // Start callback server FIRST, then open browser
    let callback_handle = tokio::spawn(async move {
        wait_for_oauth_callback(OPENAI_CALLBACK_PORT, 120).await
    });

    // Give the server a moment to start
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Now open browser
    println!("[OpenAI OAuth] Opening browser...");
    if let Err(e) = webbrowser::open(&auth_url) {
        println!("[OpenAI OAuth] Failed to open browser: {}. Please open this URL manually: {}", e, auth_url);
    }

    // Wait for callback
    let (code, returned_state) = callback_handle.await
        .map_err(|e| format!("Callback task failed: {}", e))?
        .map_err(|e| format!("OAuth callback error: {}", e))?;

    // Validate state
    if returned_state != state {
        return Err("OAuth state mismatch - possible CSRF attack".to_string());
    }

    // Exchange code for tokens (OpenAI uses form-urlencoded)
    let client = reqwest::Client::new();
    let params = [
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", &redirect_uri),
        ("client_id", OPENAI_CLIENT_ID),
        ("code_verifier", &code_verifier),
    ];

    println!("[OpenAI OAuth] Exchanging code for tokens...");

    let resp = client
        .post(OPENAI_TOKEN_ENDPOINT)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("OpenAI token exchange failed: HTTP {} - {}", status, text));
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

    println!("[OpenAI OAuth] Successfully obtained tokens!");

    Ok(OAuthTokens {
        access_token,
        refresh_token,
        expires_at,
        token_type: "Bearer".to_string(),
        provider: "openai".to_string(),
    })
}

/// Refresh OpenAI OAuth token
#[tauri::command]
pub async fn refresh_openai_token(refresh_token: String) -> Result<OAuthTokens, String> {
    let client = reqwest::Client::new();
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
        ("client_id", OPENAI_CLIENT_ID),
    ];

    let resp = client
        .post(OPENAI_TOKEN_ENDPOINT)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("OpenAI token refresh failed: HTTP {} - {}", status, text));
    }

    let token_json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let access_token = token_json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("No access_token in response")?
        .to_string();

    let new_refresh_token = token_json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or(refresh_token);

    let expires_in = token_json
        .get("expires_in")
        .and_then(|v| v.as_i64())
        .unwrap_or(3600);
    let expires_at = chrono::Utc::now().timestamp_millis() + (expires_in * 1000);

    Ok(OAuthTokens {
        access_token,
        refresh_token: new_refresh_token,
        expires_at,
        token_type: "Bearer".to_string(),
        provider: "openai".to_string(),
    })
}

/// Login to Codex CLI by running OAuth flow and writing tokens to ~/.codex/auth.json
#[tauri::command]
pub async fn login_codex_cli() -> Result<String, String> {
    println!("[Codex Login] Starting automated Codex CLI login...");

    // Run OAuth flow to get tokens
    let tokens = start_openai_oauth().await?;

    // Build the auth.json structure that Codex CLI expects
    let auth_json = serde_json::json!({
        "OPENAI_API_KEY": null,
        "tokens": {
            "id_token": "", // We don't get id_token from OAuth, but Codex may not need it
            "access_token": tokens.access_token,
            "refresh_token": tokens.refresh_token,
            "account_id": "" // Will be populated by Codex on first use
        },
        "last_refresh": chrono::Utc::now().to_rfc3339()
    });

    // Write to ~/.codex/auth.json
    let codex_dir = dirs::home_dir()
        .ok_or("Could not determine home directory")?
        .join(".codex");

    // Create directory if it doesn't exist
    if !codex_dir.exists() {
        fs::create_dir_all(&codex_dir).map_err(|e| format!("Failed to create .codex directory: {}", e))?;
    }

    let auth_path = codex_dir.join("auth.json");
    let json_str = serde_json::to_string_pretty(&auth_json).map_err(|e| e.to_string())?;
    fs::write(&auth_path, &json_str).map_err(|e| format!("Failed to write auth.json: {}", e))?;

    println!("[Codex Login] Successfully wrote credentials to {:?}", auth_path);

    Ok("Codex CLI login successful".to_string())
}

/// Check if Codex CLI is logged in (has valid auth.json with tokens)
#[tauri::command]
pub fn is_codex_logged_in() -> Result<bool, String> {
    let auth_path = dirs::home_dir()
        .ok_or("Could not determine home directory")?
        .join(".codex")
        .join("auth.json");

    if !auth_path.exists() {
        return Ok(false);
    }

    // Read and parse auth.json
    let content = fs::read_to_string(&auth_path).map_err(|e| e.to_string())?;
    let auth: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // Check if we have an access token
    let has_token = auth
        .get("tokens")
        .and_then(|t| t.get("access_token"))
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    Ok(has_token)
}

/// Helper: Wait for OAuth callback on local server
async fn wait_for_oauth_callback(port: u16, timeout_secs: u64) -> Result<(String, String), String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<(String, String)>();

    // Use a channel to signal when server is ready
    let (server_ready_tx, server_ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    std::thread::spawn(move || {
        match tiny_http::Server::http(format!("127.0.0.1:{}", port)) {
            Ok(server) => {
                println!("[OAuth Callback] Server started successfully on port {}", port);
                let _ = server_ready_tx.send(Ok(()));

                let start = std::time::Instant::now();
                let timeout = std::time::Duration::from_secs(timeout_secs);

                for request in server.incoming_requests() {
                    println!("[OAuth Callback] Received request: {}", request.url());

                    if start.elapsed() > timeout {
                        println!("[OAuth Callback] Timeout reached");
                        let _ = request.respond(tiny_http::Response::from_string("OAuth timed out"));
                        break;
                    }

                    let url_str = format!("http://localhost:{}{}", port, request.url());

                    // Skip non-callback requests (favicon, etc)
                    if !request.url().starts_with("/callback") {
                        println!("[OAuth Callback] Skipping non-callback request");
                        let _ = request.respond(tiny_http::Response::from_string(""));
                        continue;
                    }

                    if let Ok(parsed) = Url::parse(&url_str) {
                        let error = parsed
                            .query_pairs()
                            .find(|(k, _)| k == "error")
                            .map(|(_, v)| v.to_string());

                        if let Some(err) = error {
                            println!("[OAuth Callback] Error in callback: {}", err);
                            let _ = request.respond(tiny_http::Response::from_string(format!(
                                "<html><body><h1>Authentication Failed</h1><p>{}</p><p>You can close this tab.</p></body></html>",
                                err
                            )));
                            break;
                        }

                        let code = parsed
                            .query_pairs()
                            .find(|(k, _)| k == "code")
                            .map(|(_, v)| v.to_string());
                        let state = parsed
                            .query_pairs()
                            .find(|(k, _)| k == "state")
                            .map(|(_, v)| v.to_string());

                        if let (Some(c), Some(s)) = (code, state) {
                            println!("[OAuth Callback] Got code and state, sending to main thread");
                            let _ = tx.send((c.clone(), s.clone()));
                            let _ = request.respond(tiny_http::Response::from_string(
                                "<html><body style='font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;'><div style='text-align: center;'><h1>✅ Connected Successfully</h1><p>You can close this tab and return to Kondi.</p></div></body></html>",
                            ));
                            break;
                        }
                    }

                    println!("[OAuth Callback] Invalid response - missing code or state");
                    let _ = request.respond(tiny_http::Response::from_string(
                        "<html><body><h1>Invalid Response</h1><p>Missing code or state parameter.</p></body></html>",
                    ));
                    break;
                }
            }
            Err(e) => {
                println!("[OAuth Callback] Failed to start server: {}", e);
                let _ = server_ready_tx.send(Err(format!("Failed to start callback server: {}", e)));
            }
        }
    });

    // Wait for server to be ready (up to 2 seconds)
    match server_ready_rx.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(Ok(())) => println!("[OAuth] Callback server is ready"),
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("Callback server failed to start in time".to_string()),
    }

    // Wait for callback with timeout
    tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        rx
    )
    .await
    .map_err(|_| format!("OAuth callback timed out after {} seconds", timeout_secs))?
    .map_err(|e| e.to_string())
}

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
        .stderr(Stdio::piped())
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "true")
        .env_remove("CLAUDECODE");

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
        .stderr(Stdio::piped())
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "true")
        .env_remove("CLAUDECODE");

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
fn extract_session_id(output: &str) -> Option<String> {
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
        .env_remove("CLAUDECODE"); // Prevent Claude Code env from interfering

    if input.is_some() {
        cmd.stdin(Stdio::piped());
    }

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!("Failed to spawn codex command: {}. Is Codex CLI installed?", e)
    })?;

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

    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| "Codex command timed out".to_string())?
        .map_err(|e| format!("Codex command failed: {}", e))?;

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
        .stderr(Stdio::piped());

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
fn extract_codex_thread_id(output: &str) -> Option<String> {
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
fn get_codex_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home.join(".codex").join("config.toml"))
}

/// Sanitize a name for use as a TOML bare key.
/// Replaces spaces and other invalid characters with underscores.
fn sanitize_toml_key(name: &str) -> String {
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
// MCP Proxy Management Commands
// ============================================================================

/// Get the proxies directory path
fn proxies_dir() -> Option<PathBuf> {
    data_dir().map(|mut dir| {
        dir.push("kondi");
        dir.push("proxies");
        let _ = fs::create_dir_all(&dir);
        dir
    })
}

/// Get the proxy logs directory path
fn proxy_logs_dir() -> Option<PathBuf> {
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
fn find_proxy_by_name(name: &str) -> Option<ProxyConfigFile> {
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
