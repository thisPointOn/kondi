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

pub(crate) fn check_codex_credentials(home: &PathBuf) -> CLICredentialInfo {
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

pub(crate) fn check_claude_credentials(home: &PathBuf) -> CLICredentialInfo {
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

pub(crate) fn check_gemini_credentials(home: &PathBuf) -> CLICredentialInfo {
    let cred_path = home.join(".gemini").join("oauth_creds.json");
    check_oauth_file(&cred_path)
}

pub(crate) fn check_qwen_credentials(home: &PathBuf) -> CLICredentialInfo {
    let cred_path = home.join(".qwen").join("oauth_creds.json");
    check_oauth_file(&cred_path)
}

pub(crate) fn check_minimax_credentials(home: &PathBuf) -> CLICredentialInfo {
    let cred_path = home.join(".minimax").join("oauth_creds.json");
    check_oauth_file(&cred_path)
}

pub(crate) fn check_oauth_file(path: &PathBuf) -> CLICredentialInfo {
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

pub(crate) fn get_oauth_token(path: &PathBuf) -> Result<Option<String>, String> {
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
    let redirect_uri = format!("http://localhost:{}/auth/callback", OPENAI_CALLBACK_PORT);

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

    // Build authorization URL (must match Codex CLI's parameters exactly)
    let auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=kondi",
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

/// Proxy a request to the ChatGPT backend codex/responses endpoint.
/// Needed because chatgpt.com doesn't send CORS headers, so browser fetch() is blocked.
/// The codex endpoint requires stream=true, so this command handles SSE parsing
/// and returns the final response.completed event data as JSON.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn codex_request(
    body: String,
    bearerToken: String,
) -> Result<String, String> {
    // Inject stream: true into the request body (codex endpoint requires it)
    let mut body_json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Invalid JSON body: {}", e))?;
    body_json["stream"] = serde_json::Value::Bool(true);
    let body_str = serde_json::to_string(&body_json).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600)) // 10 min timeout for LLM API calls
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post("https://chatgpt.com/backend-api/codex/responses")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", bearerToken))
        .body(body_str)
        .send()
        .await
        .map_err(|e| format!("Codex request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }

    // Read the SSE stream and find the response.completed event
    let full_text = resp.text().await.unwrap_or_default();
    let mut completed_data: Option<String> = None;

    for line in full_text.lines() {
        if let Some(data) = line.strip_prefix("data: ") {
            // Try to parse and check for response.completed
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                if event.get("type").and_then(|t| t.as_str()) == Some("response.completed") {
                    // The response object is nested under "response"
                    if let Some(response) = event.get("response") {
                        completed_data = Some(response.to_string());
                    } else {
                        // Fallback: return the whole event data
                        completed_data = Some(data.to_string());
                    }
                }
            }
        }
    }

    completed_data.ok_or_else(|| {
        format!("No response.completed event found in SSE stream. Raw: {}",
            full_text.chars().take(500).collect::<String>())
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
pub(crate) async fn wait_for_oauth_callback(port: u16, timeout_secs: u64) -> Result<(String, String), String> {
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

                    // Skip non-callback requests (favicon, etc). Accept all the
                    // redirect paths our OAuth flows use — including Gemini's
                    // /oauth2callback (port 8085) which was previously skipped,
                    // leaving the connect spinner hanging forever.
                    if !request.url().starts_with("/callback")
                        && !request.url().starts_with("/auth/callback")
                        && !request.url().starts_with("/oauth2callback") {
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

