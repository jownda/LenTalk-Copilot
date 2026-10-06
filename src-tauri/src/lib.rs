pub mod ai;
pub mod commands;
pub mod database;

use std::path::PathBuf;
use std::time::Duration;

use commands::ai as ai_commands;
use commands::asset_library;
use commands::balance;
use commands::cinematic_studio;
use commands::clipboard;
use commands::cloud_drive;
use commands::image;
use commands::jimeng_cli;
use commands::media_file;
use commands::novel;
use commands::pajuben;
use commands::wan_cli;
use commands::project_state;
use commands::project_archive;
use commands::runninghub_cli;
use commands::system;
use commands::template_state;
use commands::template_sync;
use commands::update;
use commands::usage_log;
use commands::video_cfr;
use commands::video_edit;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

const MAIN_WINDOW_LABEL: &str = "main";
const FRONTEND_READY_TIMEOUT_MS: u64 = 3_500;

fn resolve_log_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(home).join("Library/Logs/storyboard-copilot"));
    }

    candidates.push(std::env::temp_dir().join("storyboard-copilot/logs"));

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join("logs"));
    }

    for directory in candidates {
        if std::fs::create_dir_all(&directory).is_ok() {
            return Some(directory);
        }
    }

    None
}

fn setup_logging() {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "info,storyboard_copilot=debug".into());

    if let Some(log_dir) = resolve_log_dir() {
        let file_appender = tracing_appender::rolling::daily(log_dir, "storyboard.log");
        let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
        std::mem::forget(_guard);

        tracing_subscriber::registry()
            .with(env_filter)
            .with(tracing_subscriber::fmt::layer().with_writer(non_blocking))
            .init();
    } else {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(tracing_subscriber::fmt::layer())
            .init();
    }

    info!("Storyboard Copilot starting...");
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(main_window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(err) = main_window.show() {
            warn!("failed to show main window: {err}");
        }
        if let Err(err) = main_window.set_focus() {
            warn!("failed to focus main window: {err}");
        }
    } else {
        warn!("main window not found while trying to reveal UI");
    }
}

/// 系统托盘: 关闭按钮之后主窗口只是收起, 靠托盘把窗口叫回来, 并提供真正的退出入口。
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "tray_show", "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray_quit", "退出应用", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("LenTalk")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_show" => show_main_window(app),
            "tray_quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(&tray.app_handle());
            }
        });

    // Windows: 左键单击直接唤起窗口, 右键弹菜单; macOS 保留菜单栏图标默认行为(点击即弹菜单)。
    #[cfg(target_os = "windows")]
    let builder = builder.show_menu_on_left_click(false);

    let builder = match app.default_window_icon().cloned() {
        Some(icon) => builder.icon(icon),
        None => builder,
    };

    builder.build(app)?;
    Ok(())
}

#[tauri::command]
fn frontend_ready(app: tauri::AppHandle) {
    info!("frontend_ready received, revealing main window");
    show_main_window(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    setup_logging();

    let app = tauri::Builder::default()
        .on_page_load(|window, _payload| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }

            info!("main page loaded, revealing main window");
            show_main_window(&window.app_handle());
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                // 关闭按钮不再退出应用: 只收起窗口(hide, 非 minimize), 进程留在后台由托盘唤起。
                api.prevent_close();
                if let Err(err) = window.hide() {
                    warn!("failed to hide main window on close: {err}");
                }
            }
        })
        .setup(|app| {
            database::initialize(app.handle())?;

            // 专有视频协议里有一部分成片只能带鉴权下载回来(帧间 / Sub2API 等),
            // 后端要把字节落盘再把本地路径交回画布。AI 层不依赖 tauri, 因此落盘
            // 实现由命令层在这里注入一次。
            ai::providers::video_protocols::install_media_persister(image::make_media_persister(
                app.handle().clone(),
            ));

            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == MAIN_WINDOW_LABEL)
                .cloned()
                .ok_or_else(|| "missing main window config".to_string())?;

            #[cfg(not(target_os = "macos"))]
            let main_window = tauri::WebviewWindowBuilder::from_config(app, &window_config)?.build()?;

            #[cfg(not(target_os = "macos"))]
            {
                if let Err(err) = main_window.hide() {
                    warn!("failed to hide main window on startup: {err}");
                }
            }

            #[cfg(target_os = "macos")]
            {
                let mut mac_window_config = window_config;
                // Window effects radius only works for transparent windows on macOS.
                mac_window_config.transparent = true;

                let window = tauri::WebviewWindowBuilder::from_config(app, &mac_window_config)?.build()?;

                if let Err(err) = window.hide() {
                    warn!("failed to hide main window on startup: {err}");
                }

                if let Err(err) = window.set_effects(Some(
                    tauri::window::EffectsBuilder::new()
                        .effect(tauri::window::Effect::Titlebar)
                        .radius(10.0)
                        .build(),
                )) {
                    warn!("failed to apply macOS window effects: {err}");
                }
            }

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(FRONTEND_READY_TIMEOUT_MS)).await;

                let is_main_visible = app_handle
                    .get_webview_window(MAIN_WINDOW_LABEL)
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);

                if !is_main_visible {
                    warn!(
                        "frontend_ready timeout after {}ms, forcing main window reveal",
                        FRONTEND_READY_TIMEOUT_MS
                    );
                    show_main_window(&app_handle);
                }
            });

            // 托盘构建失败不影响主流程(只是关闭后少一个唤起入口), 记日志继续。
            if let Err(err) = setup_tray(app.handle()) {
                warn!("failed to build system tray: {err}");
            }

            // 浏览器扩展投递通道: 端口被占满只是少一个入口, 同样不阻塞启动。
            match commands::media_bridge::start(app.handle().clone()) {
                Ok(port) => info!("media bridge listening on 127.0.0.1:{port}"),
                Err(err) => warn!("failed to start media bridge: {err}"),
            }

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(commands::pajuben::PajubenState::default())
        .manage(commands::novel::NovelState::default())
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            database::load_app_setting,
            database::save_app_setting,
            database::delete_app_setting,
            database::load_cinematic_project,
            database::save_cinematic_project,
            image::split_image,
            image::split_image_source,
            image::prepare_node_image_source,
            image::prepare_node_image_binary,
            image::crop_image_source,
            image::merge_storyboard_images,
            image::read_storyboard_image_metadata,
            image::embed_storyboard_image_metadata,
            image::load_image,
            clipboard::read_clipboard_media,
            media_file::resolve_media_file_size,
            media_file::load_media_data_url,
            video_cfr::normalize_video_cfr,
            video_cfr::prepare_video_playback,
            video_cfr::remove_video_playback_file,
            video_cfr::extract_video_frame,
            video_edit::render_video_edit,
            pajuben::pajuben_probe,
            pajuben::pajuben_run,
            pajuben::pajuben_cancel,
            pajuben::pajuben_resolve_output_dir,
            pajuben::pajuben_read_script,
            runninghub_cli::runninghub_cli_set_key,
            runninghub_cli::runninghub_cli_check,
            runninghub_cli::runninghub_cli_detect,
            runninghub_cli::runninghub_cli_install,
            runninghub_cli::runninghub_cli_logout,
            runninghub_cli::runninghub_cli_read_clipboard,
            runninghub_cli::generate_runninghub_cli_model,
            image::persist_image_source,
            image::persist_image_binary,
            image::save_image_source_to_downloads,
            image::save_image_source_to_path,
            image::save_image_source_to_directory,
            image::save_image_source_to_app_debug_dir,
            image::copy_image_source_to_clipboard,
            asset_library::load_asset_library_state,
            asset_library::save_asset_library_state,
            asset_library::persist_library_asset_binary,
            asset_library::persist_library_asset_binary_chunk,
            asset_library::persist_library_asset_file,
            asset_library::write_library_backup,
            asset_library::extract_video_thumbnail,
            cinematic_studio::project_save,
            cinematic_studio::project_load,
            cinematic_studio::prompt_save,
            cinematic_studio::prompt_load,
            cinematic_studio::version_record,
            cinematic_studio::version_list,
            cinematic_studio::keychain_set,
            cinematic_studio::keychain_get,
            ai_commands::set_api_key,
            ai_commands::verify_provider_url,
            ai_commands::test_provider_connection,
            ai_commands::fetch_provider_models,
            ai_commands::detect_provider_capabilities,
            ai_commands::request_provider_json,
            ai_commands::request_provider_multipart,
            ai_commands::request_provider_stream,
            ai_commands::submit_generate_image_job,
            ai_commands::get_generate_image_job,
            ai_commands::submit_generate_video_job,
            ai_commands::get_generate_video_job,
            ai_commands::generate_image,
            jimeng_cli::generate_jimeng_cli_video,
            jimeng_cli::generate_jimeng_cli_image,
            jimeng_cli::generate_jimeng_cli_image_upscale,
            wan_cli::generate_wan_cli_video,
            wan_cli::wan_cli_status,
            wan_cli::wan_cli_login,
            jimeng_cli::jimeng_cli_login_start,
            jimeng_cli::jimeng_cli_login_check,
            jimeng_cli::jimeng_cli_logout,
            jimeng_cli::jimeng_cli_credit,
            jimeng_cli::jimeng_cli_detect,
            jimeng_cli::jimeng_cli_install,
            wan_cli::wan_cli_credits,
            balance::query_provider_balance,
            ai_commands::chat_completion,
            ai_commands::list_models,
            project_state::list_project_summaries,
            project_state::get_project_record,
            project_state::upsert_project_record,
            project_state::update_project_viewport_record,
            project_state::rename_project_record,
            project_state::delete_project_record,
            project_archive::export_project_bundle,
            project_archive::import_project_bundle,
            cloud_drive::cloud_drive_begin_authorize,
            cloud_drive::cloud_drive_authorize_complete,
            cloud_drive::cloud_drive_status,
            cloud_drive::cloud_drive_set_credentials,
            cloud_drive::cloud_drive_set_folder,
            cloud_drive::cloud_drive_disconnect,
            cloud_drive::cloud_drive_upload_project,
            cloud_drive::cloud_drive_list_versions,
            cloud_drive::cloud_drive_restore_project,
            usage_log::append_usage_record,
            usage_log::query_usage_records,
            usage_log::query_usage_summary,
            system::get_runtime_system_info,
            template_state::list_template_records,
            template_state::get_template_record,
            template_state::save_template_record,
            template_state::delete_template_record,
            template_sync::template_sync_to_share,
            template_sync::template_sync_from_share,
            template_sync::template_upload_to_share,
            update::get_latest_release_info,
            novel::novel_environment,
            novel::novel_server_start,
            novel::novel_server_stop,
            novel::novel_server_status,
            novel::novel_api_get,
            novel::novel_api_post,
            novel::novel_asset_data_url,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // macOS: 窗口收起后点击 Dock 图标, 重新显示主窗口。
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show_main_window(app_handle);
        }

        // 退出前回收下载器 sidecar，避免留下孤儿进程。
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<commands::novel::NovelState>() {
                commands::novel::shutdown(&state);
            }
        }

        #[cfg(not(target_os = "macos"))]
        let _ = (app_handle, event);
    });
}
