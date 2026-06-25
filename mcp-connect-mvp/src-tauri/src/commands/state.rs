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
        deregister_active_pid(self.child.id());
    }
}

/// Check if a port is in use and kill any process using it
pub(crate) fn kill_process_on_port(port: u16) -> bool {
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
pub(crate) fn is_port_available(port: u16) -> bool {
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
        deregister_active_pid(self.child.id());
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

pub(crate) fn data_dir_file(file_name: &str) -> Option<PathBuf> {
    data_dir().map(|mut dir| {
        dir.push("kondi");
        let _ = fs::create_dir_all(&dir);
        dir.push(file_name);
        dir
    })
}

pub(crate) fn persist_servers_to_disk(servers: &HashMap<String, ServerConfig>) {
    if let Some(path) = data_dir_file("servers.json") {
        if let Ok(json) = serde_json::to_string_pretty(servers) {
            let _ = fs::write(path, json);
        }
    }
}

pub(crate) fn persist_keys_to_disk(keys: &ApiKeys) {
    if let Some(path) = data_dir_file("api_keys.json") {
        if let Ok(json) = serde_json::to_string_pretty(keys) {
            let _ = fs::write(path, json);
        }
    }
}

pub(crate) fn load_servers_from_disk() -> HashMap<String, ServerConfig> {
    if let Some(path) = data_dir_file("servers.json") {
        if let Ok(contents) = fs::read_to_string(path) {
            if let Ok(map) = serde_json::from_str::<HashMap<String, ServerConfig>>(&contents) {
                return map;
            }
        }
    }
    HashMap::new()
}

pub(crate) fn load_keys_from_disk() -> ApiKeys {
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

pub(crate) fn register_active_pid(pid: u32) {
    if let Some(mut path) = dirs::data_dir() {
        path.push("kondi");
        let _ = std::fs::create_dir_all(&path);
        path.push("active_pids.json");
        
        let mut pids: Vec<u32> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default();
            
        if !pids.contains(&pid) {
            pids.push(pid);
            if let Ok(content) = serde_json::to_string(&pids) {
                let _ = std::fs::write(&path, content);
            }
        }
    }
}

pub(crate) fn deregister_active_pid(pid: u32) {
    if let Some(mut path) = dirs::data_dir() {
        path.push("kondi");
        path.push("active_pids.json");
        
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(mut pids) = serde_json::from_str::<Vec<u32>>(&content) {
                if let Some(pos) = pids.iter().position(|&x| x == pid) {
                    pids.remove(pos);
                    if let Ok(new_content) = serde_json::to_string(&pids) {
                        let _ = std::fs::write(&path, new_content);
                    }
                }
            }
        }
    }
}

pub fn cleanup_orphaned_processes() {
    if let Some(mut path) = dirs::data_dir() {
        path.push("kondi");
        path.push("active_pids.json");
        
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(pids) = serde_json::from_str::<Vec<u32>>(&content) {
                println!("[App] Verifying and cleaning up {} potentially orphaned processes...", pids.len());
                for pid in pids {
                    #[cfg(unix)]
                    {
                        let status = std::process::Command::new("kill")
                            .arg("-0")
                            .arg(pid.to_string())
                            .status();
                        if let Ok(status) = status {
                            if status.success() {
                                println!("[App] Terminating orphaned process PID: {}", pid);
                                let _ = std::process::Command::new("kill")
                                    .arg("-9")
                                    .arg(pid.to_string())
                                    .status();
                            }
                        }
                    }
                    #[cfg(windows)]
                    {
                        let _ = std::process::Command::new("taskkill")
                            .args(["/PID", &pid.to_string(), "/F"])
                            .status();
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&path);
    }
}

