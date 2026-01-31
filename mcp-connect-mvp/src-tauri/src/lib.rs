use tauri::image::Image;
use tauri::Manager;

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
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
            commands::probe_server,
            // Local file system tools
            commands::read_local_file,
            commands::write_local_file,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
