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
}

pub struct McpProcess {
    pub child: Child,
    pub stdin: Option<ChildStdin>,
    pub stdout_reader: Option<BufReader<ChildStdout>>,
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

    // Wait for callback with 60 second timeout
    let (code, returned_state) = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        rx
    )
    .await
    .map_err(|_| "OAuth timed out after 60 seconds. Please try again.")?
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

    request = request
        .header("Content-Type", "application/json")
        .header("x-api-key", &apiKey)
        .header("anthropic-version", "2023-06-01");

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
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
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
                let text = resp.text().await.unwrap_or_default();
                return Err(format!("Server returned HTTP {}: {}", status, text));
            }
        }
        Err(e) => {
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
