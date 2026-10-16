mod app_state;
mod commands;
mod locations;

use app_state::DataToolsCoordinator;
use std::fmt;
use tauri::Manager;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunError {
    Bootstrap,
    EventLoop,
}

impl fmt::Display for RunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bootstrap => formatter.write_str("Data Tools bootstrap failed"),
            Self::EventLoop => formatter.write_str("Data Tools event loop failed"),
        }
    }
}

impl std::error::Error for RunError {}

pub fn run() -> Result<(), RunError> {
    tauri::Builder::default()
        .setup(|app| {
            let settings = app.path().app_config_dir()?.join("locations.json");
            let coordinator = DataToolsCoordinator::bootstrap(settings)?;
            app.manage(coordinator);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let coordinator = window.app_handle().state::<DataToolsCoordinator>();
                api.prevent_close();
                if coordinator.is_running() {
                    coordinator.cancel();
                    return;
                }
                if coordinator.finish().is_ok() {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_session_repair,
            commands::load_session_repair,
            commands::start_session_repair,
            commands::rollback_session_repair,
            commands::get_data_tools_bootstrap,
            commands::preview_openbitfun_reset,
            commands::reset_openbitfun_data,
            commands::set_data_tools_locations,
            commands::new_migration_task,
            commands::resume_migration_task,
            commands::scan_legacy_migration,
            commands::prepare_legacy_migration,
            commands::retry_writer_check,
            commands::start_legacy_migration,
            commands::cancel_data_tools_operation,
            commands::export_migration_diagnostics,
            commands::finish_data_tools,
        ])
        .run(tauri::generate_context!())
        .map_err(|_| RunError::EventLoop)
}
