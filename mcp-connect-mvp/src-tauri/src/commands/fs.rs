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

/// Delete a single file. Used by the disk-backed council store to make deletes
/// stick (otherwise a deleted council would resurrect from disk on restart).
/// A missing file is treated as success (idempotent).
#[tauri::command]
pub async fn delete_local_file(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete file: {}", e)),
    }
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

