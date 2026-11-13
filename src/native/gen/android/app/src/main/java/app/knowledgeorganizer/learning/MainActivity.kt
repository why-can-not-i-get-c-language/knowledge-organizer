package app.knowledgeorganizer.learning

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var learningWebView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    learningWebView = webView
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 为状态栏、摄像头开孔和底部手势条保留空间，避免遮挡学习按钮。
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    ViewCompat.requestApplyInsets(content)
    // 先由页面保存及收起弹层，再回到桌面；不遍历历史或结束原生运行循环。
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val webView = learningWebView
        if (webView == null) { moveTaskToBack(true); return }
        webView.evaluateJavascript("(() => { const back = window.__knowledgeOrganizerBack; if (typeof back !== 'function') return false; back(); return true; })()") { handled ->
          if (handled == "false") moveTaskToBack(true)
        }
      }
    })
  }
}
