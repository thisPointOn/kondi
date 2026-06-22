use tauri::image::Image;
use tauri::{Manager, RunEvent};

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::save_api_keys,
            commands::get_api_keys,
            commands::save_server_config,
            commands::get_server_configs,
            commands::delete_server_config,
            commands::save_chats,
            commands::load_chats,
            commands::fetch_github_manifest,
            commands::fetch_github_readme,
            commands::install_manifest_package,
            commands::start_oauth,
            commands::mcp_request,
            commands::anthropic_request,
            commands::read_claude_credentials,
            commands::probe_server,
            // Local file system tools
            commands::read_local_file,
            commands::write_local_file,
            commands::delete_local_file,
            commands::list_directory,
            commands::get_home_directory,
            commands::is_path_in_scope,
            commands::run_command,
            // GitHub sidecar / subprocess management
            commands::download_github_repo,
            commands::install_mcp_dependencies,
            commands::start_mcp_process,
            commands::send_mcp_message,
            commands::read_mcp_response,
            commands::stop_mcp_process,
            commands::is_mcp_process_running,
            commands::get_mcp_servers_dir,
            commands::detect_python_command,
            // CLI OAuth credentials
            commands::check_cli_credentials,
            commands::get_cli_token,
            commands::run_cli_login,
            // LLM Provider OAuth
            commands::start_anthropic_oauth,
            commands::exchange_anthropic_code,
            commands::refresh_anthropic_token,
            commands::start_openai_oauth,
            commands::refresh_openai_token,
            commands::codex_request,
            // Gemini (Google Cloud Code Assist)
            commands::start_gemini_oauth,
            commands::refresh_gemini_token,
            commands::gemini_request,
            // Claude Code CLI Wrapper
            commands::run_claude_command,
            commands::run_claude_streaming,
            commands::run_claude_login,
            // Codex CLI Wrapper (OpenAI)
            commands::run_codex_command,
            commands::run_codex_streaming,
            commands::login_codex_cli,
            commands::is_codex_logged_in,
            // Codex Config Management
            commands::update_codex_config,
            commands::remove_codex_mcp_server,
            commands::run_mcp_remote_auth,
            // MCP Proxy Management
            commands::list_proxy_configs,
            commands::get_proxy_config,
            commands::save_proxy_config,
            commands::delete_proxy_config,
            commands::create_proxy_from_server,
            commands::start_proxy,
            commands::stop_proxy,
            commands::is_proxy_running,
            commands::get_proxy_health,
            commands::trigger_proxy_auth,
            commands::reload_proxy,
            commands::reauthenticate_proxy,
            commands::get_all_proxy_statuses,
            // Proxy Logs
            commands::get_proxy_logs,
            commands::clear_proxy_logs,
            commands::get_all_proxy_logs,
            // LLM Config Sync
            commands::sync_proxy_to_claude_config,
            commands::remove_proxy_from_claude_config,
            commands::sync_proxy_to_codex_config,
            commands::remove_proxy_from_codex_config,
            commands::sync_all_proxies_to_llm_configs,
            // Docker Management (for SearXNG and other services)
            commands::is_docker_available,
            commands::docker_container_status,
            commands::docker_start_container,
            commands::docker_stop_container,
            commands::docker_compose_up,
            commands::docker_compose_down,
            commands::check_searxng_health,
            commands::get_kondi_data_dir,
            commands::get_guard_binary_path,
            commands::ensure_searxng_files,
        ])
        .setup(|app| {
            // Set window icon for Linux
            if let Some(window) = app.get_webview_window("main") {
                // Load icon from bytes embedded at compile time
                let icon_bytes = include_bytes!("../icons/128x128.png");
                if let Ok(icon) = Image::from_bytes(icon_bytes) {
                    let _ = window.set_icon(icon);
                }

                #[cfg(debug_assertions)]
                {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Run with event handler for cleanup
    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            println!("[App] Cleaning up processes...");
            // Get the AppState and stop all processes
            if let Some(state) = app_handle.try_state::<commands::AppState>() {
                commands::stop_all_proxies(&state);
                commands::stop_all_mcp_processes(&state);
            }
        }
    });
}
