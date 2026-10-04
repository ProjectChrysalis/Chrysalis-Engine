package org.projectchrysalis.chrysalis;

import android.content.Context;
import android.graphics.Typeface;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Terminal escape sequences become text spans; copied output remains plain. */
final class ConsoleText {
    private static final Pattern ANSI = Pattern.compile("\\x1b\\[([0-9;]*)[A-Za-z]");

    static String plain(String text) { return ANSI.matcher(text).replaceAll(""); }

    static CharSequence styled(Context context, String text) {
        SpannableStringBuilder output = new SpannableStringBuilder();
        Matcher codes = ANSI.matcher(text);
        int ink = context.getColor(R.color.ink);
        int color = ink;
        boolean bold = false;
        int previous = 0;
        while (codes.find()) {
            append(output, text.substring(previous, codes.start()), color, bold);
            if (codes.group().endsWith("m")) {
                String values = codes.group(1);
                for (String value : (values == null || values.isEmpty() ? "0" : values).split(";")) {
                    int code;
                    try { code = Integer.parseInt(value); } catch (NumberFormatException e) { continue; }
                    switch (code) {
                        case 0: color = ink; bold = false; break;
                        case 1: bold = true; break;
                        case 2: case 90: color = context.getColor(R.color.ink_muted); break;
                        case 22: bold = false; break;
                        case 31: color = context.getColor(R.color.danger); break;
                        case 32: color = context.getColor(R.color.success); break;
                        case 33: color = context.getColor(R.color.warning); break;
                        case 35: case 36: color = context.getColor(R.color.accent); break;
                        case 39: color = ink; break;
                    }
                }
            }
            previous = codes.end();
        }
        append(output, text.substring(previous), color, bold);
        return output;
    }

    private static void append(SpannableStringBuilder output, String text, int color, boolean bold) {
        int start = output.length();
        output.append(text);
        if (output.length() == start) return;
        output.setSpan(new ForegroundColorSpan(color), start, output.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        if (bold) output.setSpan(new StyleSpan(Typeface.BOLD), start, output.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    }
}
