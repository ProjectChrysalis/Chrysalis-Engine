package org.projectchrysalis.chrysalis;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;

/** Start and stop the local server, open it in the browser, and check for a
 *  newer release. Chrysalis itself runs in the phone's browser. */
public final class MainActivity extends Activity implements EngineService.Listener {
    private TextView status;
    private TextView detail;
    private Button open;
    private Button toggle;
    private Button update;
    private AlertDialog logDialog;
    private boolean openWhenReady;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        status = findViewById(R.id.status);
        detail = findViewById(R.id.detail);
        open = findViewById(R.id.open);
        toggle = findViewById(R.id.toggle);
        update = findViewById(R.id.update);
        ((TextView) findViewById(R.id.version)).setText(BuildConfig.VERSION_NAME);

        open.setOnClickListener(v -> {
            if (EngineService.state().phase == EngineService.Phase.RUNNING) {
                openBrowser();
            } else {
                openWhenReady = true;
                start();
            }
        });
        toggle.setOnClickListener(v -> {
            EngineService.Phase phase = EngineService.state().phase;
            if (phase == EngineService.Phase.STOPPED || phase == EngineService.Phase.FAILED) start();
            else startService(new Intent(this, EngineService.class).setAction(EngineService.ACTION_STOP));
        });
        findViewById(R.id.logs).setOnClickListener(v -> showLogs());
        findViewById(R.id.battery).setOnClickListener(v -> askBatteryExemption());

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        checkForUpdate();
        // a fresh launch starts the server: that is what opening the app means
        if (savedInstanceState == null && EngineService.state().phase == EngineService.Phase.STOPPED) {
            openWhenReady = true;
            start();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        EngineService.addListener(this);
        PowerManager pm = getSystemService(PowerManager.class);
        boolean exempt = pm.isIgnoringBatteryOptimizations(getPackageName());
        findViewById(R.id.battery).setVisibility(exempt ? View.GONE : View.VISIBLE);
        findViewById(R.id.battery_hint).setVisibility(exempt ? View.GONE : View.VISIBLE);
    }

    @Override
    protected void onPause() {
        EngineService.removeListener(this);
        super.onPause();
    }

    private void start() {
        startForegroundService(new Intent(this, EngineService.class).setAction(EngineService.ACTION_START));
    }

    @Override
    public void onState(EngineService.State s) {
        detail.setVisibility(View.GONE);
        switch (s.phase) {
            case STOPPED:
                status.setText(R.string.status_stopped);
                toggle.setText(R.string.action_start);
                break;
            case UNPACKING:
                status.setText(getString(R.string.status_unpacking, s.percent));
                toggle.setText(R.string.action_stop);
                break;
            case STARTING:
                status.setText(R.string.status_starting);
                toggle.setText(R.string.action_stop);
                break;
            case RUNNING:
                status.setText(R.string.status_running);
                detail.setText(s.url);
                detail.setVisibility(View.VISIBLE);
                toggle.setText(R.string.action_stop);
                if (openWhenReady) {
                    openWhenReady = false;
                    openBrowser();
                }
                break;
            case FAILED:
                status.setText(R.string.status_failed);
                if (s.error != null && !s.error.isEmpty()) {
                    detail.setText(s.error);
                    detail.setVisibility(View.VISIBLE);
                }
                toggle.setText(R.string.action_start);
                openWhenReady = false;
                break;
        }
        open.setEnabled(s.phase == EngineService.Phase.RUNNING || s.phase == EngineService.Phase.STOPPED || s.phase == EngineService.Phase.FAILED);
    }

    /** Open the server in the browser; before any account exists, open the
     *  first-run link instead. */
    private void openBrowser() {
        String base = EngineService.currentUrl(this);
        if (base == null) return;
        new Thread(() -> {
            String url = base;
            try {
                JSONObject users = Http.getJson(base + "/v1/auth/users", 3000);
                if (users.optBoolean("setup")) url = base + "/#setup=" + EngineService.setupToken(this);
            } catch (Exception ignored) {
                // open the plain address; the page explains what is wrong
            }
            String target = url;
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(target)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(this, getString(R.string.no_browser, base), Toast.LENGTH_LONG).show();
                }
            });
        }, "chrysalis-open").start();
    }

    /** The end of the engine log, or the service output when the engine never
     *  got far enough to write one. */
    private String logText() {
        File engineLog = new File(EngineService.homeDir(this), "data/logs/chrysalis.log");
        String text = EngineService.lastLines(engineLog, 400);
        String output = EngineService.lastLines(EngineService.outputFile(this), 60);
        return "Chrysalis " + BuildConfig.VERSION_NAME + " (Android " + Build.VERSION.RELEASE + ")\n\n" + (text.isEmpty() ? output : text);
    }

    private void copyLog() {
        getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Chrysalis log", logText()));
        Toast.makeText(this, R.string.log_copied, Toast.LENGTH_SHORT).show();
    }

    /** The log on screen, tailed every couple of seconds while the dialog is
     *  open. Scrolling up pauses the auto-scroll so reading is not fought. */
    private void showLogs() {
        TextView view = new TextView(this);
        int pad = Math.round(getResources().getDisplayMetrics().density * 14);
        view.setPadding(pad, pad, pad, pad);
        view.setTypeface(Typeface.MONOSPACE);
        view.setTextSize(11);
        view.setTextColor(getColor(R.color.ink));
        view.setTextIsSelectable(true);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(getColor(R.color.base));
        scroll.addView(view, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        scroll.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.round(getResources().getDisplayMetrics().heightPixels * 0.55f)));

        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle(R.string.logs_title)
            .setView(scroll)
            .setPositiveButton(R.string.logs_close, null)
            .setNeutralButton(R.string.logs_copy, null)
            .create();

        Handler handler = new Handler(Looper.getMainLooper());
        Runnable[] tail = new Runnable[1];
        tail[0] = () -> {
            new Thread(() -> {
                String text = logText();
                runOnUiThread(() -> {
                    if (!dialog.isShowing()) return;
                    boolean atBottom = atBottom(scroll);
                    view.setText(text.isEmpty() ? getString(R.string.logs_empty) : text);
                    if (atBottom) scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
                });
            }, "chrysalis-log").start();
            handler.postDelayed(tail[0], 2000);
        };
        dialog.setOnDismissListener(d -> handler.removeCallbacks(tail[0]));
        dialog.setOnShowListener(d -> {
            // Copy keeps the dialog open: the log stays readable while it is shared
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> copyLog());
        });
        logDialog = dialog;
        dialog.show();
        tail[0].run();
    }

    @Override
    protected void onDestroy() {
        // the tail runnable must not outlive the activity behind the dialog
        if (logDialog != null && logDialog.isShowing()) logDialog.dismiss();
        super.onDestroy();
    }

    private boolean atBottom(ScrollView scroll) {
        View child = scroll.getChildAt(0);
        if (child == null) return true;
        int slack = Math.round(getResources().getDisplayMetrics().density * 24);
        return child.getBottom() - (scroll.getHeight() + scroll.getScrollY()) <= slack;
    }

    @SuppressWarnings("BatteryLife")
    private void askBatteryExemption() {
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException e) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    /** A newer release on the project's GitHub page shows a button to it. The
     *  APK is downloaded and installed by the person, in the browser. */
    private void checkForUpdate() {
        String repo = BuildConfig.REPOSITORY;
        if (!repo.startsWith("https://github.com/")) return;
        String slug = repo.substring("https://github.com/".length()).replaceAll("\\.git$|/$", "");
        new Thread(() -> {
            try {
                JSONObject release = Http.getJson("https://api.github.com/repos/" + slug + "/releases/latest", 8000);
                String tag = release.getString("tag_name").replaceFirst("^v", "");
                String page = release.getString("html_url");
                if (!Versions.newer(tag, BuildConfig.VERSION_NAME)) return;
                runOnUiThread(() -> {
                    update.setText(getString(R.string.action_update, tag));
                    update.setVisibility(View.VISIBLE);
                    update.setOnClickListener(v -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(page))));
                });
            } catch (Exception ignored) {
                // offline or no releases yet
            }
        }, "chrysalis-update").start();
    }
}
