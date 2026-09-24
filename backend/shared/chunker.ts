/**
 * Splits repository files into retrieval-sized chunks.
 * Markdown is split on headings (so a chunk is one doc section); code is split
 * into overlapping line windows.
 */
export interface SourceFile {
  path: string;
  content: string;
}

export interface Chunk {
  key: string;
  path: string;
  kind: "doc" | "code";
  text: string;
}

const MAX_CHUNK_CHARS = 1800;
const CODE_WINDOW_LINES = 60;
const CODE_OVERLAP_LINES = 10;

export const TEXT_EXTENSIONS = [
  ".md", ".markdown", ".txt", ".rst",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".java", ".go", ".rb", ".rs", ".cs", ".php",
  ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".html", ".css", ".sh", ".ps1", ".sql",
];

export function isDocPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".rst") || lower.endsWith(".txt") ||
    lower.startsWith("docs/");
}

export function isIndexable(path: string, size = 0): boolean {
  const lower = path.toLowerCase();
  if (size > 100_000) return false;
  if (/(^|\/)(node_modules|dist|build|\.git|vendor|coverage)\//.test(lower)) return false;
  if (/package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$/.test(lower)) return false;
  const name = lower.split("/").pop() ?? "";
  if (name === "dockerfile" || name === "makefile" || name === "license") return true;
  return TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function splitLong(text: string, max = MAX_CHUNK_CHARS): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    if ((current + "\n\n" + paragraph).length > max && current) {
      parts.push(current);
      current = "";
    }
    if (paragraph.length > max) {
      for (let offset = 0; offset < paragraph.length; offset += max) parts.push(paragraph.slice(offset, offset + max));
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function chunkMarkdown(file: SourceFile): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of file.content.split("\n")) {
    if (/^#{1,3}\s/.test(line) && current.join("\n").trim()) {
      sections.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.join("\n").trim()) sections.push(current.join("\n").trim());
  return sections.flatMap((section) => splitLong(section));
}

function chunkCode(file: SourceFile): string[] {
  const lines = file.content.split("\n");
  const windows: string[] = [];
  for (let start = 0; start < lines.length; start += CODE_WINDOW_LINES - CODE_OVERLAP_LINES) {
    const window = lines.slice(start, start + CODE_WINDOW_LINES).join("\n").trim();
    if (window) windows.push(`// lines ${start + 1}-${Math.min(start + CODE_WINDOW_LINES, lines.length)}\n${window}`);
    if (start + CODE_WINDOW_LINES >= lines.length) break;
  }
  return windows.flatMap((window) => splitLong(window));
}

export function chunkFile(file: SourceFile): Chunk[] {
  const kind = isDocPath(file.path) ? "doc" : "code";
  const pieces = kind === "doc" ? chunkMarkdown(file) : chunkCode(file);
  return pieces.map((text, index) => ({
    key: `${kind}:${file.path}#${index}`,
    path: file.path,
    kind,
    // Prefix the path so the embedding knows where the text came from.
    text: `File: ${file.path}\n${text}`,
  }));
}
