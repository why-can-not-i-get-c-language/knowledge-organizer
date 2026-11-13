package app.knowledgeorganizer.learning

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class AppShellPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun background(invoke: Invoke) {
    activity.runOnUiThread {
      // 与桌面手势离开应用保持一致，不销毁现有Activity/WebView或进程。
      if (activity.moveTaskToBack(true)) invoke.resolve(JSObject())
      else invoke.reject("无法返回桌面，请使用系统手势")
    }
  }
}
