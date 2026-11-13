use serde::{Deserialize, Serialize};
use tauri::{plugin::{Builder, TauriPlugin}, AppHandle, Runtime};
#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};

#[cfg(target_os = "android")]
struct Scanner<R: Runtime>(PluginHandle<R>);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile { path: String, id: String, version: String, title: String, question_count: u32, size: u64 }
#[derive(Deserialize, Serialize)]
pub struct Listing { files: Vec<ScannedFile>, partial: bool, cancelled: bool }
#[derive(Deserialize)]
struct ReadResult { text: String }

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("library-scan").setup(|_app, _api| {
        #[cfg(target_os = "android")]
        _app.manage(Scanner(_api.register_android_plugin("app.knowledgeorganizer.learning", "LibraryScanner")?));
        Ok(())
    }).build()
}

#[tauri::command]
pub async fn scan_device<R: Runtime>(_app: AppHandle<R>) -> Result<Listing, String> {
    #[cfg(target_os = "android")]
    return _app.state::<Scanner<R>>().0.run_mobile_plugin_async("scan", serde_json::json!({})).await.map_err(|e| e.to_string());
    #[cfg(not(target_os = "android"))]
    Err("此设备暂不支持自动扫描，请直接导入题集".into())
}
#[tauri::command]
pub async fn read_scanned_file<R: Runtime>(_app: AppHandle<R>, path: String) -> Result<String, String> {
    #[cfg(target_os = "android")]
    { let result: ReadResult = _app.state::<Scanner<R>>().0.run_mobile_plugin_async("read", serde_json::json!({"path": path})).await.map_err(|e| e.to_string())?; Ok(result.text) }
    #[cfg(not(target_os = "android"))]
    { let _ = path; Err("请直接选择题集文件".into()) }
}
#[tauri::command]
pub async fn cancel_device_scan<R: Runtime>(_app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    { let _: serde_json::Value = _app.state::<Scanner<R>>().0.run_mobile_plugin_async("cancel", serde_json::json!({})).await.map_err(|e| e.to_string())?; }
    Ok(())
}
