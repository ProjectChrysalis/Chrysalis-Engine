package org.projectchrysalis.chrysalis;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * The engine's resources (web client, shipped apps, browser runtimes) ride in
 * the APK as one zip and are unpacked into app storage once per app version.
 * A new version unpacks beside the old copy and swaps it in, so an
 * interrupted unpack never leaves a half-written tree behind.
 */
final class Payload {
    interface Progress {
        void onProgress(int percent);
    }

    private static final String ASSET = "resources.zip";
    private static final String PREF_INSTALLED_AT = "payload_installed_at";

    private Payload() {}

    static File resourcesDir(Context context) {
        return new File(context.getFilesDir(), "resources");
    }

    /** When this APK was installed. Every staging build of one version shares
     *  its version code, so a newer build with the same code is still a new
     *  payload; the install time, not the version, says whether it is stale. */
    private static long installedAt(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).lastUpdateTime;
        } catch (Exception e) {
            return -1;
        }
    }

    /** Unpack the resources if this APK install has not done so yet. */
    static void ensure(Context context, Progress progress) throws IOException {
        SharedPreferences prefs = context.getSharedPreferences("launcher", Context.MODE_PRIVATE);
        File target = resourcesDir(context);
        long installedAt = installedAt(context);
        if (prefs.getLong(PREF_INSTALLED_AT, -1) == installedAt && new File(target, "client/dist/index.html").isFile()) return;

        File staging = new File(context.getFilesDir(), "resources.unpacking");
        deleteTree(staging);
        long total = context.getAssets().openFd(ASSET).getLength();
        String root = staging.getCanonicalPath() + File.separator;
        try (CountingStream counted = new CountingStream(context.getAssets().open(ASSET));
             ZipInputStream zip = new ZipInputStream(counted)) {
            byte[] buf = new byte[1 << 16];
            int lastPercent = -1;
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                File out = new File(staging, entry.getName());
                // an entry naming ../ must not write outside the staging folder
                if (!out.getCanonicalPath().startsWith(root)) throw new IOException("bad entry " + entry.getName());
                if (entry.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null) parent.mkdirs();
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    int n;
                    while ((n = zip.read(buf)) > 0) fos.write(buf, 0, n);
                }
                int percent = (int) Math.min(99, counted.count * 100 / Math.max(1, total));
                if (percent != lastPercent) {
                    lastPercent = percent;
                    progress.onProgress(percent);
                }
            }
        }
        File old = new File(context.getFilesDir(), "resources.old");
        deleteTree(old);
        if (target.exists() && !target.renameTo(old)) throw new IOException("could not replace " + target);
        if (!staging.renameTo(target)) throw new IOException("could not move resources into place");
        deleteTree(old);
        prefs.edit().putLong(PREF_INSTALLED_AT, installedAt).apply();
    }

    static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static final class CountingStream extends FilterInputStream {
        long count;

        CountingStream(InputStream in) {
            super(in);
        }

        @Override
        public int read() throws IOException {
            int b = super.read();
            if (b >= 0) count++;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            int n = super.read(b, off, len);
            if (n > 0) count += n;
            return n;
        }
    }
}
