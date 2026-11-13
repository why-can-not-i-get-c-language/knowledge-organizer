use tauri::{plugin::{Builder, TauriPlugin}, AppHandle, Runtime, ipc::Channel};
use serde_json::{json, Value};
#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};
#[cfg(target_os = "android")]
struct DeepSeek<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("deepseek").setup(|app, api| {
        #[cfg(target_os = "android")]
        app.manage(DeepSeek(api.register_android_plugin("app.knowledgeorganizer.learning", "DeepSeekPlugin")?));
        #[cfg(not(target_os = "android"))]
        let _ = (app, api);
        Ok(())
    }).build()
}
async fn call<R: Runtime>(app: AppHandle<R>, command: &str, args: Value) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    { app.state::<DeepSeek<R>>().0.run_mobile_plugin_async(command, args).await.map_err(|e| e.to_string()) }
    #[cfg(not(target_os = "android"))]
    { let _ = (app, command, args); Err("此平台尚未接入安全密钥存储，请使用安卓安装版".into()) }
}
#[tauri::command]
pub async fn deepseek_settings<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> { call(app, "settings", json!({})).await }
#[tauri::command]
pub async fn deepseek_configure<R: Runtime>(app: AppHandle<R>, model: String, max_output_tokens: u32, key: Option<String>) -> Result<Value, String> {
    call(app, "configure", json!({"model":model,"maxOutputTokens":max_output_tokens,"key":key})).await
}
#[tauri::command]
pub async fn deepseek_remove_key<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> { call(app, "removeKey", json!({})).await }
#[tauri::command]
pub async fn deepseek_check<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> { call(app, "check", json!({})).await }
#[tauri::command]
pub async fn deepseek_stream<R: Runtime>(app: AppHandle<R>, id: String, model: String, max_output_tokens: u32, messages: Value, on_event: Channel<Value>) -> Result<Value, String> {
    call(app, "stream", json!({"id":id,"model":model,"maxOutputTokens":max_output_tokens,"messages":messages,"onEvent":on_event})).await
}
#[tauri::command]
pub async fn deepseek_cancel<R: Runtime>(app: AppHandle<R>, id: String) -> Result<Value, String> { call(app, "cancel", json!({"id":id})).await }
