package app.knowledgeorganizer.learning

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.storage.StorageManager
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.ArrayDeque
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean

@InvokeArg
class ScanFileArgs { lateinit var path: String }

@TauriPlugin(permissions = [Permission(alias = "storage", strings = [Manifest.permission.READ_EXTERNAL_STORAGE])])
class LibraryScanner(private val activity: Activity) : Plugin(activity) {
  private val busy = AtomicBoolean(false)
  private val cancelled = AtomicBoolean(false)
  private val candidates = Collections.synchronizedSet(mutableSetOf<String>())
  private val maxBytes = 10L * 1024 * 1024

  @Command
  fun scan(invoke: Invoke) {
    if (!busy.compareAndSet(false, true)) { invoke.reject("正在查找题集，请稍候"); return }
    cancelled.set(false)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
        val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${activity.packageName}"))
        try { startActivityForResult(invoke, intent, "allFilesResult") }
        catch (_: Exception) { startActivityForResult(invoke, Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), "allFilesResult") }
      } else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R && ContextCompat.checkSelfPermission(activity, Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
        requestPermissionForAlias("storage", invoke, "storageResult")
      } else beginScan(invoke)
    } catch (_: Exception) { busy.set(false); invoke.reject("无法开始查找，请在系统中允许文件访问后重试") }
  }

  @ActivityCallback
  fun allFilesResult(invoke: Invoke, result: ActivityResult) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()) beginScan(invoke)
    else { busy.set(false); invoke.reject("未允许查找文件。允许文件访问后即可扫描，也可以直接导入题集") }
  }

  @PermissionCallback
  fun storageResult(invoke: Invoke) {
    if (ContextCompat.checkSelfPermission(activity, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) beginScan(invoke)
    else { busy.set(false); invoke.reject("未允许查找文件，请在系统应用权限中开启后重试") }
  }

  private fun roots(): List<File> {
    val result = mutableListOf(Environment.getExternalStorageDirectory())
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val manager = activity.getSystemService(StorageManager::class.java)
      manager.storageVolumes.mapNotNullTo(result) { it.directory }
    }
    activity.getExternalFilesDirs(null).filterNotNull().forEach { file ->
      val base = file.absolutePath.substringBefore("/Android/")
      if (base != file.absolutePath) result.add(File(base))
    }
    return result.mapNotNull { try { it.canonicalFile } catch (_: Exception) { null } }.filter { it.isDirectory }.distinctBy { it.path }
  }

  private fun readBounded(file: File): String {
    if (file.length() !in 1..maxBytes) throw IllegalArgumentException()
    return file.inputStream().use { input ->
      val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
      while (true) { val count = input.read(buffer); if (count < 0) break; if (output.size().toLong() + count > maxBytes) throw IllegalArgumentException(); output.write(buffer, 0, count) }
      output.toString("UTF-8")
    }
  }

  private fun beginScan(invoke: Invoke) {
    // 遍历和JSON预筛选在独立线程执行；只读公共存储，不修改或上传文件。
    Thread {
      try {
        val roots = roots(); val pending = ArrayDeque<File>(); roots.forEach { pending.add(it); pending.add(File(it, "Android/media")) }
        val visited = mutableSetOf<String>(); val found = JSArray(); var partial = false; var entries = 0
        val deadline = System.nanoTime() + 300_000_000_000L
        candidates.clear()
        while (pending.isNotEmpty() && !cancelled.get()) {
          if (entries++ >= 500000 || System.nanoTime() > deadline || found.length() >= 1000) { partial = true; break }
          val file = pending.removeFirst()
          val path = try { file.canonicalPath } catch (_: Exception) { continue }
          if (!roots.any { path == it.path || path.startsWith(it.path + File.separator) } || !visited.add(path)) continue
          if (roots.any { path == it.path + "/Android/data" || path.startsWith(it.path + "/Android/data/") || path == it.path + "/Android/obb" || path.startsWith(it.path + "/Android/obb/") }) continue
          if (file.isDirectory) {
            try { file.listFiles()?.forEach { if (it.name != ".thumbnails" && it.name != ".cache") pending.add(it) } } catch (_: SecurityException) { }
          } else if (file.isFile && file.extension.equals("json", ignoreCase = true) && file.length() in 1..maxBytes) {
            try {
              val content = readBounded(file); val json = JSONObject(content); val questions = json.optJSONArray("questions") ?: continue
              val id = json.opt("id") as? String ?: continue; val version = json.opt("version") as? String ?: continue; val title = json.opt("title") as? String ?: continue
              if (json.optInt("schemaVersion") != 1 || questions.length() !in 1..1000 || id.isBlank() || id.length > 100 || version.isBlank() || version.length > 100 || title.isBlank() || title.length > 20000) continue
              val item = JSObject(); item.put("path", path); item.put("id", id); item.put("version", version); item.put("title", title); item.put("questionCount", questions.length()); item.put("size", content.toByteArray(Charsets.UTF_8).size)
              candidates.add(path); found.put(item)
            } catch (_: Exception) { /* 非题集JSON不进入候选，不向用户展示校验日志。 */ }
          }
        }
        val result = JSObject(); result.put("files", found); result.put("partial", partial); result.put("cancelled", cancelled.get()); invoke.resolve(result)
      } catch (_: Exception) { invoke.reject("暂时无法查找文件，请稍后重试") }
      finally { busy.set(false) }
    }.start()
  }

  @Command
  fun read(invoke: Invoke) {
    Thread {
      try {
        val path = File(invoke.parseArgs(ScanFileArgs::class.java).path).canonicalPath
        if (!candidates.contains(path)) { invoke.reject("文件列表已变化，请重新扫描"); return@Thread }
        val result = JSObject(); result.put("text", readBounded(File(path))); invoke.resolve(result)
      } catch (_: Exception) { invoke.reject("无法读取这个题集，请重新扫描或直接导入") }
    }.start()
  }

  @Command
  fun cancel(invoke: Invoke) { cancelled.set(true); invoke.resolve(JSObject()) }
}
