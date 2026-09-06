/**
 * Pure Markdown rendering for pi-md-log.
 *
 * Produces *user-editable notes*: assistant text is passed through as Markdown
 * (including LaTeX), thinking blocks are excluded by default, tool activity is
 * collapsed into `<details>`, and compaction/branch summaries become blockquotes.
 *
 * No per-unit anchor comments are emitted: this file may be edited freely and
 * the extension only ever appends.
 */
import { markdownFence, sanitizeTerminalOutput } from "./sanitize.ts";
import { truncateForTranscript } from "./truncate.ts";

export interface LogOptions {
  /** Record assistant thinking/reasoning blocks. Default false. */
  includeThinking?: boolean;
  /** Record `!` / `!!` terminal commands (bashExecution). Default false. */
  includeBashExecution?: boolean;
}

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
export function renderEntries(entries: LogEntry[], options: LogOptions = {}): string {
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
        parts.push(renderOrphanToolResult(message));
      } else if (role === "bashExecution") {
        if (options.includeBashExecution) parts.push(renderBashExecution(entry, message));
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
  options: LogOptions,
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
      sections.push(`<details>\n<summary>💭 Thinking</summary>\n\n${block.thinking.trim()}\n\n</details>`);
      continue;
    }
    if (block.type === "toolCall") {
      const id = block.id ?? "";
      const result = id ? results.get(id) : undefined;
      if (id) consumed.add(id);
      sections.push(renderToolActivity(block.name ?? "tool", block.arguments, result));
    }
  }

  return sections.join("\n\n") || "_(no text content)_";
}

function renderOrphanToolResult(message: LogMessageLike): string {
  const name = message.toolName ?? "tool";
  return `<details>\n<summary>🔧 ${name} · result</summary>\n\n${renderResultContent(message)}\n\n</details>`;
}

function renderToolActivity(
  name: string,
  args: unknown,
  result: LogMessageLike | undefined,
): string {
  const summaryName = name === "bash" || name === "powershell" ? `$ ${commandFromArgs(args)}` : name;
  const sections = [`<details>`, `<summary>🔧 ${summaryName}</summary>`, "", renderArguments(name, args)];
  if (result) {
    sections.push("", "**Result**", "", renderResultContent(result));
  }
  sections.push("", "</details>");
  return sections.join("\n");
}

function renderResultContent(message: LogMessageLike): string {
  const text = contentText(message.content, message).trim();
  if (!text) return "_no text output_";
  const cleaned = sanitizeTerminalOutput(text);
  const truncated = truncateForTranscript(cleaned);
  const notice = truncated.truncated
    ? `\n\n> Output truncated: ${truncated.totalLines.toLocaleString()} lines / ${truncated.totalBytes.toLocaleString()} bytes total.`
    : "";
  const flag = message.isError ? "\n\n> This call returned an error." : "";
  return `${markdownFence(truncated.content, "text")}${notice}${flag}`;
}

function commandFromArgs(args: unknown): string {
  if (args !== null && typeof args === "object") {
    const record = args as Record<string, unknown>;
    if (typeof record.command === "string") return truncateChars(record.command, 120);
  }
  return nameOf(args);
}

function renderArguments(name: string, args: unknown): string {
  if (name === "bash" || name === "powershell") {
    const record = (args ?? {}) as Record<string, unknown>;
    const command = typeof record.command === "string" ? record.command : "";
    return `**Command**\n\n${markdownFence(truncateChars(command, 4000), name === "powershell" ? "powershell" : "bash")}`;
  }
  const json = args === undefined ? "{}" : compactJson(args);
  return `**Arguments**\n\n${markdownFence(truncateChars(json, 4000), "json")}`;
}

function renderBashExecution(entry: LogEntry, message: LogMessageLike): string {
  const command = message.command ?? "";
  const output = message.output ?? "";
  const prefix = message.excludeFromContext ? "!!" : "!";
  const cleaned = sanitizeTerminalOutput(output);
  const truncated = truncateForTranscript(cleaned);
  const notice = truncated.truncated
    ? `\n\n> Output truncated: ${truncated.totalLines.toLocaleString()} lines total.`
    : "";
  const status = typeof message.exitCode === "number" ? ` · exit ${message.exitCode}` : "";
  return [
    "---",
    "",
    `### \`${prefix}\` ${truncateChars(command, 200)}${status} · ${timestampLabel(entry.timestamp, message.timestamp)}`,
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

function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n… content truncated (${value.length - max} chars omitted)…`;
}

function nameOf(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
}
