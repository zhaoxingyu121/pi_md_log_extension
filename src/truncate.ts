export interface TextTruncation {
  content: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
  totalChars: number;
  outputChars: number;
}

export interface TextTruncationOptions {
  maxLines?: number;
  maxChars?: number;
  headRatio?: number;
}

/** Default budget for long tool/terminal text kept in a note. */
export const DEFAULT_OUTPUT_MAX_LINES = 200;
export const DEFAULT_OUTPUT_MAX_CHARS = 20_000;
export const DEFAULT_OUTPUT_HEAD_RATIO = 0.4;

/**
 * Head+tail truncation shared by tool arguments and tool results.
 *
 * The line budget runs first: when the text is too tall, it keeps `headRatio`
 * of the lines from the start and the rest from the end. The character budget
 * then runs on what is left, splitting the same way, so the beginning and the
 * end of the text survive and the middle is replaced by an omission marker.
 */
export function truncateText(input: string, options: TextTruncationOptions = {}): TextTruncation {
  const maxLines = options.maxLines ?? DEFAULT_OUTPUT_MAX_LINES;
  const maxChars = options.maxChars ?? DEFAULT_OUTPUT_MAX_CHARS;
  const headRatio = options.headRatio ?? DEFAULT_OUTPUT_HEAD_RATIO;

  const allLines = input.split("\n");
  const totalLines = allLines.length;
  const totalChars = input.length;

  if (totalLines <= maxLines && totalChars <= maxChars) {
    return {
      content: input,
      truncated: false,
      totalLines,
      outputLines: totalLines,
      totalChars,
      outputChars: totalChars,
    };
  }

  // Stage 1 — lines: keep head/tail lines when the text is too tall.
  const linesTruncated = totalLines > maxLines;
  let head: string;
  let tail: string;
  let omittedLines = 0;
  if (linesTruncated) {
    const headLineCount = Math.max(1, Math.floor(maxLines * headRatio));
    const tailLineCount = Math.max(1, maxLines - headLineCount);
    head = allLines.slice(0, headLineCount).join("\n");
    tail = allLines.slice(-tailLineCount).join("\n");
    omittedLines = Math.max(0, totalLines - headLineCount - tailLineCount);
  } else {
    head = input;
    tail = "";
  }

  // Stage 2 — characters: split the remaining budget between head and tail.
  const marker = linesTruncated
    ? `\n\n… ${omittedLines.toLocaleString()} lines omitted …\n\n`
    : "\n\n… middle of text omitted …\n\n";
  const availableChars = Math.max(2, maxChars - marker.length);
  const headChars = Math.max(1, Math.floor(availableChars * headRatio));
  const tailChars = Math.max(1, availableChars - headChars);

  if (linesTruncated) {
    head = head.slice(0, headChars);
    tail = tail.length > tailChars ? tail.slice(tail.length - tailChars) : tail;
  } else {
    head = input.slice(0, headChars);
    tail = input.slice(input.length - tailChars);
  }

  const content = `${head}${marker}${tail}`;
  return {
    content,
    truncated: true,
    totalLines,
    outputLines: content.split("\n").length,
    totalChars,
    outputChars: content.length,
  };
}
