package app.projectionmapper.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;

import app.projectionmapper.server.MapperServer;

/**
 * Full-screen projector output. Starts the built-in web server (so phones on
 * the same Wi-Fi can connect by scanning the QR code) and shows the projector
 * page in a WebView.
 */
public class MainActivity extends Activity {
    private static final String TAG = "ProjectionMapper";
    private static final int PORT = 8080;

    private static MapperServer server; // survives activity re-creation
    private WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private long lastBack;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, "js: " + m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // If the page itself failed (server still starting), try again shortly.
                if (request.isForMainFrame()) main.postDelayed(MainActivity.this::loadDisplay, 1000);
            }
        });
        setContentView(web);
        hideSystemUi();

        new Thread(() -> {
            try {
                startServer();
                main.post(this::loadDisplay);
            } catch (final IOException e) {
                Log.e(TAG, "server failed", e);
                main.post(() -> web.loadData("<body style='background:#000;color:#fff;font:24px sans-serif;padding:40px'>"
                        + "Could not start the built-in server: " + e.getMessage() + "</body>", "text/html", "utf-8"));
            }
        }, "server-start").start();
    }

    private synchronized void startServer() throws IOException {
        if (server != null) return;
        final AssetManager assets = getAssets();
        MapperServer srv = new MapperServer(new MapperServer.WebRoot() {
            @Override
            public byte[] read(String path) throws IOException {
                if (path.isEmpty() || path.endsWith("/")) return null;
                try (InputStream in = assets.open(path)) {
                    return MapperServer.readAll(in);
                } catch (FileNotFoundException e) {
                    return null;
                }
            }
        }, new File(getFilesDir(), "data"), PORT);
        srv.start();
        server = srv;
        Log.i(TAG, "server on port " + srv.getPort() + " " + MapperServer.lanAddresses());
    }

    private void loadDisplay() {
        if (server == null || web == null) return;
        web.loadUrl("http://127.0.0.1:" + server.getPort() + "/display.html");
    }

    private void hideSystemUi() {
        View decor = getWindow().getDecorView();
        int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN;
        if (Build.VERSION.SDK_INT >= 19) flags |= View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
        decor.setSystemUiVisibility(flags);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemUi();
            if (web != null) web.requestFocus();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            // Avoid ending the show by accident: press Back twice to exit.
            long now = System.currentTimeMillis();
            if (now - lastBack < 2500) {
                finish();
            } else {
                lastBack = now;
                Toast.makeText(this, "Press Back again to exit Projection Mapper", Toast.LENGTH_SHORT).show();
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        if (isFinishing() && server != null) {
            server.stop();
            server = null;
        }
        super.onDestroy();
    }
}
