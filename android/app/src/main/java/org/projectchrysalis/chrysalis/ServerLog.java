package org.projectchrysalis.chrysalis;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;

/** Current-run output stays bounded even when requests contain large prompts. */
final class ServerLog {
    private static final int MAX_BYTES = 1024 * 1024;
    private static final int KEEP_BYTES = MAX_BYTES / 2;
    private static final int READ_BYTES = 256 * 1024;

    static void copy(InputStream input, File file) throws IOException {
        try (RandomAccessFile output = new RandomAccessFile(file, "rw")) {
            synchronized (ServerLog.class) { output.setLength(0); }
            byte[] chunk = new byte[8192];
            int count;
            while ((count = input.read(chunk)) != -1) {
                synchronized (ServerLog.class) {
                    output.seek(output.length());
                    output.write(chunk, 0, count);
                    if (output.length() > MAX_BYTES) {
                        byte[] tail = tailBytes(output, KEEP_BYTES);
                        output.setLength(0);
                        output.seek(0);
                        output.write(tail);
                    }
                }
            }
        }
    }

    static synchronized String lastLines(File file, int lines) {
        if (lines <= 0) return "";
        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            String[] all = new String(tailBytes(input, READ_BYTES), StandardCharsets.UTF_8).split("\n");
            StringBuilder text = new StringBuilder();
            for (int i = Math.max(0, all.length - lines); i < all.length; i++) text.append(all[i]).append('\n');
            return text.toString().trim();
        } catch (IOException e) {
            return "";
        }
    }

    private static byte[] tailBytes(RandomAccessFile input, int maxBytes) throws IOException {
        long length = input.length();
        long start = Math.max(0, length - maxBytes);
        byte[] bytes = new byte[(int) (length - start)];
        input.seek(start);
        input.readFully(bytes);
        if (start == 0) return bytes;
        int from = 0;
        while (from < bytes.length && (bytes[from] & 0xc0) == 0x80) from++;
        for (int i = from; i < bytes.length; i++) {
            if (bytes[i] == '\n' && i + 1 < bytes.length) { from = i + 1; break; }
        }
        return java.util.Arrays.copyOfRange(bytes, from, bytes.length);
    }
}
