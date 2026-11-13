use tauri::{plugin::{Builder, TauriPlugin}, AppHandle, Runtime};
#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};
#[cfg(target_os = "android")]
struct AppShell<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("app-shell").setup(|app, api| {
        #[cfg(target_os = "android")]
        app.manage(AppShell(api.register_android_plugin("app.knowledgeorganizer.learning", "AppShellPlugin")?));
        #[cfg(not(target_os = "android"))]
        let _ = (app, api);
        Ok(())
    }).build()
}

#[tauri::command]
pub async fn exit_app<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        // 手机退出到桌面而不结束Tauri运行循环，重开继续使用同一WebView。
        let _: serde_json::Value = app.state::<AppShell<R>>().0
            .run_mobile_plugin_async("background", serde_json::json!({})).await.map_err(|_| "暂时无法返回桌面，请使用系统手势".to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    { app.exit(0); Ok(()) }
}
