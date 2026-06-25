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

