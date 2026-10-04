package org.projectchrysalis.chrysalis;

import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import static org.junit.Assert.*;

public class ServerLogTest {
    @Test public void returnsRecentLinesAndResetsEachRun() throws Exception {
        File file = File.createTempFile("server-log", ".txt");
        try {
            Files.write(file.toPath(), "previous run\n".getBytes(StandardCharsets.UTF_8));
            ServerLog.copy(new ByteArrayInputStream("one\ntwo\nthree\n".getBytes(StandardCharsets.UTF_8)), file);
            assertEquals("two\nthree", ServerLog.lastLines(file, 2));
            assertEquals("", ServerLog.lastLines(file, 0));
        } finally { file.delete(); }
    }

    @Test public void boundsOutputAndKeepsLatestUnicodeLines() throws Exception {
        File file = File.createTempFile("server-log", ".txt");
        try {
            String output = "旧い🙂 output\n".repeat(200000) + "recent🙂\nlast line\n";
            ServerLog.copy(new ByteArrayInputStream(output.getBytes(StandardCharsets.UTF_8)), file);
            assertTrue(file.length() <= 1024 * 1024);
            assertEquals("recent🙂\nlast line", ServerLog.lastLines(file, 2));
            assertFalse(ServerLog.lastLines(file, 400).contains("\ufffd"));
        } finally { file.delete(); }
    }

    @Test public void keepsTailOfSingleHugeLine() throws Exception {
        File file = File.createTempFile("server-log", ".txt");
        try {
            String output = "🙂".repeat(400000) + "final-detail\n";
            ServerLog.copy(new ByteArrayInputStream(output.getBytes(StandardCharsets.UTF_8)), file);
            String tail = ServerLog.lastLines(file, 1);
            assertTrue(tail.endsWith("final-detail"));
            assertFalse(tail.contains("\ufffd"));
            assertTrue(file.length() <= 1024 * 1024);
        } finally { file.delete(); }
    }
}
