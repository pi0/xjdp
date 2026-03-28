// Terminal formatting utilities

export function dim(text: string): string {
  return `\x1B[2m${text}\x1B[0m`;
}

export function bold(text: string): string {
  return `\x1B[1m${text}\x1B[0m`;
}

export function red(text: string): string {
  return `\x1B[31m${text}\x1B[0m`;
}

export function green(text: string): string {
  return `\x1B[32m${text}\x1B[0m`;
}

export function yellow(text: string): string {
  return `\x1B[33m${text}\x1B[0m`;
}

export function cyan(text: string): string {
  return `\x1B[36m${text}\x1B[0m`;
}

export function magenta(text: string): string {
  return `\x1B[35m${text}\x1B[0m`;
}

export function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Lightweight JS syntax highlighting for terminal display */
export function formatJS(code: string): string {
  const keywords = new Set([
    "const",
    "let",
    "var",
    "function",
    "return",
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "new",
    "delete",
    "typeof",
    "instanceof",
    "in",
    "of",
    "class",
    "extends",
    "super",
    "this",
    "import",
    "export",
    "from",
    "default",
    "async",
    "await",
    "try",
    "catch",
    "finally",
    "throw",
    "yield",
    "void",
    "null",
    "undefined",
    "true",
    "false",
  ]);

  // Tokenize: strings, comments, numbers, identifiers, whitespace, and single chars
  const tokens =
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d+(?:\.\d+)?|[a-zA-Z_$][\w$]*|\s+|./g;

  return code.replace(tokens, (tok) => {
    if (tok.startsWith("//") || tok.startsWith("/*")) return dim(tok);
    if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith("`")) return green(tok);
    if (/^\d/.test(tok)) return yellow(tok);
    if (keywords.has(tok)) return magenta(tok);
    return tok;
  });
}
