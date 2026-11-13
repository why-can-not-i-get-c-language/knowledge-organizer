package app.knowledgeorganizer.learning

import android.app.Activity
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class DeepSeekConfigArgs { lateinit var model: String; var maxOutputTokens: Int = 2048; var key: String? = null }
@InvokeArg
class DeepSeekStreamArgs {
  lateinit var id: String; lateinit var model: String; var maxOutputTokens: Int = 2048
  lateinit var messages: List<Map<String, String>>; lateinit var onEvent: Channel
}
@InvokeArg
class DeepSeekCancelArgs { lateinit var id: String }

@TauriPlugin
class DeepSeekPlugin(private val activity: Activity) : Plugin(activity) {
  private val preferences = activity.getSharedPreferences("deepseek", 0)
  private val alias = "knowledge-organizer.deepseek.v1"
  private class RequestState {
    val cancelled = AtomicBoolean(false); val timeout = AtomicBoolean(false)
    @Volatile var connection: HttpURLConnection? = null
  }
  private val requests = ConcurrentHashMap<String, RequestState>()
  private val cancelledIds = ConcurrentHashMap.newKeySet<String>()
  private val busy = AtomicBoolean(false)

  @Synchronized private fun encryptionKey(create: Boolean): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    if (store.containsAlias(alias)) return store.getKey(alias, null) as SecretKey
    if (!create) throw IllegalStateException("SECRET")
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    return generator.generateKey()
  }
  @Synchronized private fun readKey(): String {
    val encrypted = preferences.getString("key", null) ?: throw IllegalStateException("NO_KEY")
    try {
      val parts = encrypted.split(":"); val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, encryptionKey(false), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
      return String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
    } catch (_: Exception) { throw IllegalStateException("SECRET") }
  }
  private fun validSettings(model: String, tokens: Int) = model.matches(Regex("[A-Za-z0-9._-]{1,100}")) && tokens in 256..16384
  @Command fun settings(invoke: Invoke) {
    val result = JSObject(); result.put("configured", preferences.contains("key"))
    result.put("model", preferences.getString("model", "deepseek-flash")); result.put("maxOutputTokens", preferences.getInt("tokens", 2048)); invoke.resolve(result)
  }
  @Command fun configure(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(DeepSeekConfigArgs::class.java)
      if (!validSettings(args.model, args.maxOutputTokens)) { invoke.reject("INVALID_INPUT"); return }
      val edit = preferences.edit().putString("model", args.model).putInt("tokens", args.maxOutputTokens)
      args.key?.let { key ->
        if (key.length !in 8..512 || key.any { it.code !in 33..126 }) throw IllegalArgumentException()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, encryptionKey(true))
        val encrypted = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(cipher.doFinal(key.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        edit.putString("key", encrypted)
      }
      if (!edit.commit()) throw IllegalStateException()
      invoke.resolve(JSObject())
    } catch (_: Exception) { invoke.reject("SECRET") }
  }
  @Command fun removeKey(invoke: Invoke) {
    if (preferences.edit().remove("key").commit()) invoke.resolve(JSObject()) else invoke.reject("SECRET")
  }
  private fun connection(path: String): HttpURLConnection {
    val key = readKey()
    return (URL("https://api.deepseek.com$path").openConnection() as HttpURLConnection).apply {
      connectTimeout = 20000; readTimeout = 60000; instanceFollowRedirects = false
      setRequestProperty("Authorization", "Bearer $key"); setRequestProperty("Content-Type", "application/json")
    }
  }
  private fun checkStatus(connection: HttpURLConnection) {
    when (connection.responseCode) {
      in 200..299 -> return
      401, 403 -> throw IllegalStateException("AUTH")
      402 -> throw IllegalStateException("BALANCE")
      429 -> throw IllegalStateException("RATE_LIMIT")
      400, 404, 422 -> throw IllegalStateException("INVALID_INPUT")
      else -> throw IllegalStateException("NETWORK")
    }
  }
  private fun reject(invoke: Invoke, error: Exception, state: RequestState? = null) {
    val safe = setOf("AUTH", "BALANCE", "RATE_LIMIT", "INVALID_INPUT", "NO_KEY", "SECRET")
    invoke.reject(when { state?.cancelled?.get() == true -> "CANCELLED"; state?.timeout?.get() == true || error is java.net.SocketTimeoutException -> "TIMEOUT"; error.message in safe -> error.message!!; else -> "NETWORK" })
  }
  @Command fun check(invoke: Invoke) {
    Thread {
      var conn: HttpURLConnection? = null
      try { conn = connection("/models"); checkStatus(conn); invoke.resolve(JSObject()) }
      catch (error: Exception) { reject(invoke, error) }
      finally { conn?.disconnect() }
    }.start()
  }
  @Command fun cancel(invoke: Invoke) {
    try {
      val id = invoke.parseArgs(DeepSeekCancelArgs::class.java).id
      if (id.length !in 1..100) throw IllegalArgumentException()
      if (cancelledIds.size >= 128) cancelledIds.clear()
      cancelledIds.add(id)
      requests[id]?.let { it.cancelled.set(true); it.connection?.disconnect() }
      invoke.resolve(JSObject())
    }
    catch (_: Exception) { invoke.reject("INVALID_INPUT") }
  }
  @Command fun stream(invoke: Invoke) {
    if (!busy.compareAndSet(false, true)) { invoke.reject("BUSY"); return }
    val state = RequestState()
    val args = try { invoke.parseArgs(DeepSeekStreamArgs::class.java) } catch (_: Exception) { busy.set(false); invoke.reject("INVALID_INPUT"); return }
    if (!validSettings(args.model, args.maxOutputTokens) || args.id.length !in 1..100 || args.messages.size !in 1..104 || args.messages.any { it.keys != setOf("role", "content") || it["role"] !in setOf("system", "user", "assistant") }) {
      busy.set(false); invoke.reject("INVALID_INPUT"); return
    }
    requests[args.id] = state
    if (cancelledIds.remove(args.id)) state.cancelled.set(true)
    Thread {
      val timer = Timer(true)
      try {
        val body = JSONObject().put("model", args.model).put("messages", JSONArray(args.messages))
          .put("max_tokens", args.maxOutputTokens).put("thinking", JSONObject().put("type", "disabled"))
          .put("stream", true).put("stream_options", JSONObject().put("include_usage", true)).toString().toByteArray(Charsets.UTF_8)
        if (body.size > 1024 * 1024) throw IllegalArgumentException()
        val conn = connection("/chat/completions"); state.connection = conn
        timer.schedule(object : TimerTask() { override fun run() { state.timeout.set(true); conn.disconnect() } }, 180000)
        if (state.cancelled.get()) throw IllegalStateException()
        conn.requestMethod = "POST"; conn.doOutput = true; conn.setRequestProperty("Accept", "text/event-stream")
        conn.setFixedLengthStreamingMode(body.size); conn.outputStream.use { it.write(body) }; checkStatus(conn)
        // 只转发SSE数据。没有服务端DONE或连接中断时，前端保留部分回答并标记中断。
        conn.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
          val line = StringBuilder(); val data = mutableListOf<String>(); var count = 0; var done = false
          fun dispatch() { if (data.isNotEmpty()) { val text = data.joinToString("\n"); val result = JSObject(); result.put("data", text); args.onEvent.send(result); data.clear(); if (text == "[DONE]") done = true } }
          while (!done && !state.cancelled.get() && !state.timeout.get()) {
            val ch = reader.read(); if (ch < 0) { if (line.isNotEmpty()) throw IllegalStateException(); dispatch(); break }
            if (++count > 2 * 1024 * 1024 || line.length > 131072) throw IllegalStateException()
            if (ch == 10) { val text = line.toString().removeSuffix("\r"); line.setLength(0)
              if (text.isEmpty()) dispatch() else if (text.startsWith("data:")) data.add(text.substring(5).removePrefix(" "))
            } else line.append(ch.toChar())
          }
        }
        if (state.cancelled.get() || state.timeout.get()) throw IllegalStateException()
        val end = JSObject(); end.put("eof", true); args.onEvent.send(end); invoke.resolve(JSObject())
      } catch (error: Exception) { reject(invoke, error, state) }
      finally { timer.cancel(); state.connection?.disconnect(); requests.remove(args.id); busy.set(false) }
    }.start()
  }
}
