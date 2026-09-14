export interface TranscriptTruncation {
  content: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
  totalBytes: number;
  outputBytes: number;
}

export interface TranscriptTruncationOptions {
  maxLines?: number;
  maxBytes?: number;
  headRatio?: number;
}

/** Default budget for long tool/terminal output kept in a note. */
export const DEFAULT_OUTPUT_MAX_LINES = 200;
export const DEFAULT_OUTPUT_MAX_BYTES = 20 * 1024;
export const DEFAULT_OUTPUT_HEAD_RATIO = 0.4;

function utf8Prefix(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;

  let used = 0;
  let output = "";
  for (const character of input) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

function utf8Suffix(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;

  let used = 0;
  const output: string[] = [];
  const characters = Array.from(input);
  for (let index = characters.length - 1; index >= 0; index--) {
    const character = characters[index];
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    output.push(character);
    used += bytes;
  }
  return output.reverse().join("");
}

export function truncateForTranscript(
  input: string,
  options: TranscriptTruncationOptions = {},
): TranscriptTruncation {
  const maxLines = options.maxLines ?? DEFAULT_OUTPUT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_OUTPUT_MAX_BYTES;
  const headRatio = options.headRatio ?? DEFAULT_OUTPUT_HEAD_RATIO;
  const originalLines = input.split("\n");
  const totalLines = originalLines.length;
  const totalBytes = Buffer.byteLength(input, "utf8");

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content: input,
      truncated: false,
      totalLines,
      outputLines: totalLines,
      totalBytes,
      outputBytes: totalBytes,
    };
  }

  const headLineCount = Math.max(1, Math.floor(maxLines * headRatio));
  const tailLineCount = Math.max(1, maxLines - headLineCount);
  let head = originalLines.slice(0, headLineCount).join("\n");
  let tail = originalLines.slice(-tailLineCount).join("\n");

  const omittedLines = Math.max(0, totalLines - headLineCount - tailLineCount);
  const marker = omittedLines > 0
    ? `\n\n… ${omittedLines.toLocaleString()} lines omitted …\n\n`
    : "\n\n… middle of output omitted …\n\n";
  const availableBytes = Math.max(2, maxBytes - Buffer.byteLength(marker, "utf8"));
  const headBytes = Math.max(1, Math.floor(availableBytes * headRatio));
  const tailBytes = Math.max(1, availableBytes - headBytes);
  head = utf8Prefix(head, headBytes);
  tail = utf8Suffix(tail, tailBytes);

  const content = `${head}${marker}${tail}`;
  return {
    content,
    truncated: true,
    totalLines,
    outputLines: content.split("\n").length,
    totalBytes,
    outputBytes: Buffer.byteLength(content, "utf8"),
  };
}
