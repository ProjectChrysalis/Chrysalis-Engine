package org.projectchrysalis.chrysalis;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Small blocking JSON GET, for the engine's health check and update checks. */
final class Http {
    private Http() {}

    static JSONObject getJson(String url, int timeoutMs) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(timeoutMs);
        conn.setReadTimeout(timeoutMs);
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("User-Agent", "Chrysalis-Android/" + BuildConfig.VERSION_NAME);
        try {
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) throw new IOException("HTTP " + code);
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
            } catch (org.json.JSONException e) {
                throw new IOException("not JSON", e);
            }
        } finally {
            conn.disconnect();
        }
    }
}
