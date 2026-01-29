use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use dirs::data_dir;
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
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
    use std::process::Command;

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
    let output = Command::new("sh")
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
