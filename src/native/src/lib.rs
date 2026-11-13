#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![exit_app, scanner::scan_device, scanner::read_scanned_file, scanner::cancel_device_scan])
        .plugin(scanner::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .run(tauri::generate_context!())
        .expect("知识梳理器启动失败");
}
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}
mod scanner;
