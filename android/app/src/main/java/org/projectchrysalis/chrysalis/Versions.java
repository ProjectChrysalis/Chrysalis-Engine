package org.projectchrysalis.chrysalis;

/** Dotted version comparison ("1.10.0" is newer than "1.9.2"). */
final class Versions {
    private Versions() {}

    static boolean newer(String candidate, String current) {
        String[] a = candidate.split("[.-]");
        String[] b = current.split("[.-]");
        for (int i = 0; i < 3; i++) {
            int x = part(a, i);
            int y = part(b, i);
            if (x != y) return x > y;
        }
        return false;
    }

    private static int part(String[] parts, int i) {
        if (i >= parts.length) return 0;
        try {
            return Integer.parseInt(parts[i]);
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
