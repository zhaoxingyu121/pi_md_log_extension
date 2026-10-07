/**
 * Pure Markdown rendering for pi-md-log.
 *
 * Produces *user-editable notes*: assistant text is passed through as Markdown
 * (including LaTeX), thinking blocks are excluded by default, tool activity is
 * collapsed into a fold (`<details>` or an Obsidian callout, per `foldStyle`),
 * short tool arguments are merged into the fold summary, and compaction/branch
 * summaries become blockquotes.
 *
 * No per-unit anchor comments are emitted: this file may be edited freely and
 * the extension only ever appends.
 */
import { markdownFence, sanitizeTerminalOutput } from "./sanitize.ts";
import { truncateText } from "./truncate.ts";

/**
 * Rendering / truncation settings for pi-md-log.
 *
 * The values come from the single user-editable config file (see `config.ts`),
 * so nothing here is hardcoded at the call sites.
 */
/** Collapsible block syntax: HTML `<details>` or Obsidian callouts. */
export type FoldStyle = "details" | "obsidian";

export interface LogOptions {
  /** Record assistant thinking/reasoning blocks. */
  includeThinking: boolean;
  /** Record `!` / `!!` terminal commands (bashExecution). */
  includeBashExecution: boolean;
  /** Max lines kept from tool arguments / results before head+tail truncation. */
  outputMaxLines: number;
  /** Max chars kept from tool arguments / results before head+tail truncation. */
  outputMaxChars: number;
  /** Fraction of the truncation budget kept from the head (0..1, tail gets the rest). */
  outputHeadRatio: number;
  /** Max chars of a command/argument before it is folded instead of inlined. */
  commandMaxChars: number;
  /** Max chars for the command in a `bashExecution` heading. */
  bashCommandMaxChars: number;
  /** Collapsible block syntax: HTML `<details>` or Obsidian callouts. */
  foldStyle: FoldStyle;
}

/** Alias kept for readability at call sites. */
export type ResolvedLogOptions = LogOptions;

export interface ContentBlockLike {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  mimeType?: string;
  mediaType?: string;
}

export interface LogMessageLike {
  role?: string;
  content?: string | ContentBlockLike[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  errorMessage?: string;
  stopReason?: string;
  /** bashExecution (role "bashExecution") fields. */
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  excludeFromContext?: boolean;
}

export interface LogEntry {
  id: string;
  type: string;
  /** Entry timestamp (ISO string from the session file). */
  timestamp?: string;
  /** Present when type === "message". */
  message?: LogMessageLike;
  /** Present when type === "compaction" | "branch_summary". */
  summary?: string;
  tokensBefore?: number;
}

/** Front matter written exactly once when the extension creates the file. */
export function logFileHeader(sessionId: string, title: string): string {
  const lines = [
    `<!-- pi-md-log:1:session=${sessionId} -->`,
    "",
    `# ${title}`,
    "",
    "> Managed by pi-md-log: the extension only appends to the end of this file. Feel free to edit, annotate, or delete anything.",
  ];
  return lines.join("\n");
}

export function exportSegmentHeading(sessionId: string, sessionName?: string, at: Date = new Date()): string {
  const id = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
  const name = sessionName ? ` · ${sessionName}` : "";
  return `## 📤 Export snapshot · ${formatTimestamp(at)}${name} · ${id}`;
}

/** Render the appendable body for a batch of entries (path order, root -> leaf). */
export function renderEntries(entries: LogEntry[], options: ResolvedLogOptions): string {
  const parts: string[] = [];

  // Pair tool results with their calls inside this batch.
  const results = new Map<string, LogMessageLike>();
  for (const entry of entries) {
    const message = entry.message;
    if (entry.type !== "message" || !message || message.role !== "toolResult") continue;
    if (message.toolCallId) results.set(message.toolCallId, message);
  }
  const consumed = new Set<string>();

  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const message = entry.message;
      const role = message.role ?? "custom";

      if (role === "user") {
        parts.push(renderUser(entry, message));
      } else if (role === "assistant") {
        parts.push(renderAssistant(entry, message, results, consumed, options));
      } else if (role === "toolResult") {
        if (message.toolCallId && consumed.has(message.toolCallId)) continue;
        parts.push(renderOrphanToolResult(message, options));
      } else if (role === "bashExecution") {
        if (options.includeBashExecution) parts.push(renderBashExecution(entry, message, options));
      }
      continue;
    }

    if (entry.type === "compaction") {
      parts.push(renderFold("📌 Context compacted", entry, entry.summary));
    } else if (entry.type === "branch_summary") {
      parts.push(renderFold("🌿 Branch summary", entry, entry.summary));
    }
    // custom / custom_message / label / model_change / thinking_level_change -> not part of notes
  }

  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderUser(entry: LogEntry, message: LogMessageLike): string {
  const text = contentText(message.content, message);
  const time = timestampLabel(entry.timestamp, message.timestamp);
  const sections = [`## Q · ${time}`];
  if (text) sections.push(text);
  else sections.push("_(empty message)_");
  return sections.join("\n\n");
}

function renderAssistant(
  entry: LogEntry,
  message: LogMessageLike,
  results: Map<string, LogMessageLike>,
  consumed: Set<string>,
  options: ResolvedLogOptions,
): string {
  const sections: string[] = [];
  const suffix =
    message.stopReason === "error" || message.stopReason === "aborted" ? ` · ${message.stopReason}` : "";
  if (suffix || message.errorMessage) {
    sections.push(`> Assistant response issue${suffix}${message.errorMessage ? `: ${message.errorMessage}` : ""}`);
  }

  const blocks: ContentBlockLike[] = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];

  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      sections.push(block.text.replace(/\n{3,}/g, "\n\n").trim());
      continue;
    }
    if (block.type === "thinking" && options.includeThinking && block.thinking) {
      sections.push(renderFoldBlock("💭 Thinking", block.thinking.trim(), options.foldStyle));
      continue;
    }
    if (block.type === "toolCall") {
      const id = block.id ?? "";
      const result = id ? results.get(id) : undefined;
      if (id) consumed.add(id);
      sections.push(renderToolActivity(block.name ?? "tool", block.arguments, result, options));
    }
  }

  return sections.join("\n\n") || "_(no text content)_";
}

function renderOrphanToolResult(message: LogMessageLike, options: ResolvedLogOptions): string {
  const name = message.toolName ?? "tool";
  return renderFoldBlock(`🔧 ${name} · result`, renderResultContent(message, options), options.foldStyle);
}

interface ToolDisplay {
  /** Summary text shown next to the tool name (already includes the tool name). */
  label: string;
  /** Argument sections folded into the collapsible body. */
  sections: string[];
}

function renderToolActivity(
  name: string,
  args: unknown,
  result: LogMessageLike | undefined,
  options: ResolvedLogOptions,
): string {
  const display = describeToolCall(name, args, options);
  const body = [...display.sections];
  if (result) body.push(`**Result**\n\n${renderResultContent(result, options)}`);
  const content = body.join("\n\n") || "_no arguments or output_";
  return renderFoldBlock(`🔧 ${display.label}`, content, options.foldStyle);
}

function renderResultContent(message: LogMessageLike, options: ResolvedLogOptions): string {
  const text = contentText(message.content, message).trim();
  if (!text) return "_no text output_";
  const cleaned = sanitizeTerminalOutput(text);
  const truncated = truncateText(cleaned, {
    maxLines: options.outputMaxLines,
    maxChars: options.outputMaxChars,
    headRatio: options.outputHeadRatio,
  });
  const notice = truncated.truncated
    ? `\n\n> Output truncated: ${truncated.totalLines.toLocaleString()} lines / ${truncated.totalChars.toLocaleString()} chars total.`
    : "";
  const flag = message.isError ? "\n\n> This call returned an error." : "";
  return `${markdownFence(truncated.content, "text")}${notice}${flag}`;
}

function describeToolCall(name: string, args: unknown, options: ResolvedLogOptions): ToolDisplay {
  const record = asRecord(args);
  switch (name) {
    case "read":
      return describeRead(record);
    case "write":
      return describeWrite(record, options);
    case "edit":
      return describeEdit(record, options);
    case "bash":
    case "powershell":
      return describeShell(name, record, options);
    default:
      return describeGeneric(name, record, options);
  }
}

/** `read <path>:<start>-<end>`; offset/limit are folded into a line range. */
function describeRead(record: Record<string, unknown>): ToolDisplay {
  const path = pathOf(record);
  if (!path) return { label: "read", sections: [] };
  const offset = numberOrUndefined(record.offset);
  const limit = numberOrUndefined(record.limit);
  let range = "";
  if (offset !== undefined || limit !== undefined) {
    const start = offset ?? 1;
    const end = limit !== undefined ? start + limit : "";
    range = `:${start}${end === "" ? "-" : `-${end}`}`;
  }
  return { label: `read ${path}${range}`, sections: [] };
}

/** `write <path>` in the summary, file content folded with a language fence. */
function describeWrite(record: Record<string, unknown>, options: ResolvedLogOptions): ToolDisplay {
  const path = pathOf(record);
  const content = textOf(record.content);
  const label = path ? `write ${path}` : "write";
  if (content === undefined) return { label, sections: [] };
  return {
    label,
    sections: [
      `**Content**\n\n${markdownFence(truncateForNote(content, options), fenceLanguageForPath(path))}`,
    ],
  };
}

/** `edit <path>` in the summary, each edit's old/new text folded. */
function describeEdit(record: Record<string, unknown>, options: ResolvedLogOptions): ToolDisplay {
  const path = pathOf(record);
  const label = path ? `edit ${path}` : "edit";
  const language = fenceLanguageForPath(path);
  const rawEdits = Array.isArray(record.edits) ? record.edits : [];
  const sections: string[] = [];

  for (const [index, rawEdit] of rawEdits.entries()) {
    const edit = asRecord(rawEdit);
    const oldText = textOf(edit.oldText);
    const newText = textOf(edit.newText);
    const parts: string[] = [];
    if (rawEdits.length > 1) parts.push(`**Edit ${index + 1}**`);
    if (oldText !== undefined) {
      parts.push(`**Old**\n\n${markdownFence(truncateForNote(oldText, options), language)}`);
    }
    if (newText !== undefined) {
      parts.push(`**New**\n\n${markdownFence(truncateForNote(newText, options), language)}`);
    }
    if (parts.length > 0) sections.push(parts.join("\n\n"));
  }

  return { label, sections };
}

/** Inline a short single-line shell command; fold long/multiline commands. */
function describeShell(name: string, record: Record<string, unknown>, options: ResolvedLogOptions): ToolDisplay {
  const command = textOf(record.command) ?? "";
  if (command === "") return { label: name, sections: [] };
  if (!command.includes("\n") && command.length <= options.commandMaxChars) {
    return { label: `$ ${command}`, sections: [] };
  }
  const language = name === "powershell" ? "powershell" : "bash";
  return {
    label: name,
    sections: [`**Command**\n\n${markdownFence(truncateForNote(command, options), language)}`],
  };
}

/**
 * Fallback for other tools (grep/find/ls/...): inline a short, single-line
 * description in the summary; fold anything long or multiline.
 */
function describeGeneric(name: string, record: Record<string, unknown>, options: ResolvedLogOptions): ToolDisplay {
  if (Object.keys(record).length === 0) return { label: name, sections: [] };
  const compact = singleLineJson(record);
  if (compact.length <= options.commandMaxChars && !hasMultilineText(record)) {
    return { label: `${name} ${inlineArgsSummary(record)}`.trim(), sections: [] };
  }
  return {
    label: name,
    sections: [
      `**Arguments**\n\n${markdownFence(truncateForNote(compactJson(record), options), "json")}`,
    ],
  };
}

/** True when any string anywhere in the value contains a newline. */
function hasMultilineText(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\n");
  if (Array.isArray(value)) return value.some(hasMultilineText);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasMultilineText);
  }
  return false;
}

function inlineArgsSummary(record: Record<string, unknown>): string {
  const pattern = textOf(record.pattern);
  if (pattern !== undefined) {
    const scope = textOf(record.path);
    return `/${pattern}/${scope ? ` in ${scope}` : ""}`;
  }
  for (const key of ["path", "file_path", "filePath", "command", "query", "url", "name", "glob"]) {
    const value = textOf(record[key]);
    if (value !== undefined) return value;
  }
  return singleLineJson(record);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pathOf(record: Record<string, unknown>): string | undefined {
  return textOf(record.path) ?? textOf(record.file_path) ?? textOf(record.filePath);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function singleLineJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  sql: "sql",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
};

function fenceLanguageForPath(path: string | undefined): string {
  if (!path) return "";
  const base = path.split(/[\\/]/).pop() ?? "";
  if (base.toLowerCase() === "dockerfile") return "dockerfile";
  if (!base.includes(".")) return "";
  const extension = base.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_LANGUAGES[extension] ?? "";
}

/**
 * Render a collapsible block. `details` uses HTML `<details>`; `obsidian` uses
 * a foldable callout (`> [!note]- Title`) with every body line quoted.
 */
function renderFoldBlock(title: string, body: string, style: FoldStyle): string {
  const normalized = body.trim();
  if (style === "obsidian") {
    const quoted = normalized
      .split("\n")
      .map((line) => (line.length > 0 ? `> ${line}` : ">"))
      .join("\n");
    return `> [!note]- ${title}\n${quoted}`;
  }
  return `<details>\n<summary>${title}</summary>\n\n${normalized}\n\n</details>`;
}

function renderBashExecution(entry: LogEntry, message: LogMessageLike, options: ResolvedLogOptions): string {
  const command = message.command ?? "";
  const output = message.output ?? "";
  const prefix = message.excludeFromContext ? "!!" : "!";
  const cleaned = sanitizeTerminalOutput(output);
  const truncated = truncateText(cleaned, {
    maxLines: options.outputMaxLines,
    maxChars: options.outputMaxChars,
    headRatio: options.outputHeadRatio,
  });
  const notice = truncated.truncated
    ? `\n\n> Output truncated: ${truncated.totalLines.toLocaleString()} lines / ${truncated.totalChars.toLocaleString()} chars total.`
    : "";
  const status = typeof message.exitCode === "number" ? ` · exit ${message.exitCode}` : "";
  return [
    "---",
    "",
    `### \`${prefix}\` ${truncateChars(command, options.bashCommandMaxChars)}${status} · ${timestampLabel(entry.timestamp, message.timestamp)}`,
    "",
    markdownFence(command, "bash"),
    "",
    "**Output**",
    "",
    `${markdownFence(truncated.content, "text")}${notice}`,
  ].join("\n");
}

function renderFold(emoji: string, entry: LogEntry, summary: string | undefined): string {
  const tokens = typeof entry.tokensBefore === "number" ? `(${entry.tokensBefore.toLocaleString()} tokens)` : "";
  const time = entry.timestamp ? formatTimestamp(new Date(entry.timestamp)) : "";
  const body = summary && summary.trim() ? `\n\n${blockquote(summary.trim())}` : "";
  return `> ${emoji} ${time}${tokens ? ` · ${tokens}` : ""}${body}`;
}

function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function contentText(content: LogMessageLike["content"], message: LogMessageLike): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  let images = 0;
  for (const block of content) {
    if (block.type === "text" && block.text) parts.push(block.text);
    else if (block.type === "image") images += 1;
  }
  const text = parts.join("\n\n");
  const note = images > 0 ? `\n\n> _(${images} image${images > 1 ? "s" : ""} omitted)_` : "";
  return `${text}${note}`.trim();
}

function timestampLabel(entryTimestamp: string | undefined, messageTimestamp: number | undefined): string {
  const raw = entryTimestamp ?? (messageTimestamp ? new Date(messageTimestamp).toISOString() : undefined);
  return raw ? formatTimestamp(new Date(raw)) : "";
}

export function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Tool arguments use the same head+tail budget as tool results. */
function truncateForNote(value: string, options: ResolvedLogOptions): string {
  return truncateText(value, {
    maxLines: options.outputMaxLines,
    maxChars: options.outputMaxChars,
    headRatio: options.outputHeadRatio,
  }).content;
}

function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
