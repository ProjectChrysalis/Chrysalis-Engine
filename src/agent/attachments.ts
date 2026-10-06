import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yauzl from "yauzl";
import { getDocumentProxy } from "unpdf";
import { makePathGuard } from "../sandbox/workspace.js";

export const MAX_ATTACHMENT_BYTES = 64 * 1024 ** 2;
const MAX_TEXT_BYTES = 16 * 1024 ** 2;

async function wordText(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? new Error("Invalid document")); return; }
      let found = false;
      zip.on("error", reject);
      zip.on("end", () => { if (!found) reject(new Error("Document has no readable body")); });
      zip.on("entry", (entry) => {
        if (entry.fileName !== "word/document.xml") { zip.readEntry(); return; }
        found = true;
        if (entry.uncompressedSize > MAX_TEXT_BYTES) { zip.close(); reject(new Error("Document text exceeds 16 MB")); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { zip.close(); reject(error ?? new Error("Cannot read document")); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_TEXT_BYTES) stream.destroy(new Error("Document text exceeds 16 MB"));
            else chunks.push(chunk);
          });
          stream.on("error", (error) => { zip.close(); reject(error); });
          stream.on("end", () => {
            zip.close();
            const xml = Buffer.concat(chunks).toString("utf8");
            const text = [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<\/w:p>/g)]
              .map((match) => match[1] ?? (match[0].startsWith("<w:tab") ? "\t" : "\n")).join("");
            resolve(text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
              if (code.startsWith("#")) {
                const number = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
                return number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : entity;
              }
              return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[code] ?? entity;
            }));
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function documentText(file: string, bytes: Uint8Array, name: string): Promise<string | null> {
  if (/\.docx$/i.test(name)) return wordText(file);
  if (/\.pdf$/i.test(name) || Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-") {
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { useSystemFonts: false });
    try {
      if (pdf.numPages > 2000) throw new Error("Document exceeds 2000 pages");
      const pages: string[] = [];
      let size = 0;
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        const text = content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("");
        size += Buffer.byteLength(text);
        if (size > MAX_TEXT_BYTES) throw new Error("Document text exceeds 16 MB");
        pages.push(`[Page ${number}]\n${text}`);
        page.cleanup();
      }
      return pages.join("\n\n");
    } finally { await pdf.loadingTask.destroy(); }
  }
  if (bytes.subarray(0, 8192).includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}

/** Originals are kept even when text extraction is unavailable. */
export async function saveAttachment(root: string, name: string, bytes: Uint8Array) {
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("File exceeds 64 MB");
  const chars = Array.from(path.basename(name.replace(/\\/g, "/"))).filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
  while (Buffer.byteLength(chars.join("")) > 180) chars.pop();
  const cleaned = chars.join("");
  const filename = !cleaned || cleaned === "." || cleaned === ".." ? "file" : cleaned;
  const id = randomUUID();
  const relative = `attachments/${id}`;
  const dir = path.join(root, relative);
  fs.mkdirSync(root, { recursive: true });
  makePathGuard(root).assertWritable(dir, relative);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), bytes, { flag: "wx" });
  let readable: string | undefined, notice: string | undefined;
  try {
    const text = await documentText(path.join(dir, filename), bytes, filename);
    if (text !== null) {
      if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error("Document text exceeds 16 MB");
      // The extracted path never collides with an uploaded filename.
      const extracted = "__text-" + randomUUID() + ".txt";
      fs.writeFileSync(path.join(dir, extracted), text, { flag: "wx" });
      readable = `${relative}/${extracted}`;
      if (!text.replace(/\[Page \d+\]/g, "").trim()) notice = "No readable text found. Scanned pages require OCR.";
    } else notice = "No text extractor for this format. The original file is available.";
  } catch (error) { notice = `Text extraction failed: ${(error as Error).message}. The original file is available.`; }
  return { id, name: filename, path: `${relative}/${filename}`, readable, notice, size: bytes.length };
}
