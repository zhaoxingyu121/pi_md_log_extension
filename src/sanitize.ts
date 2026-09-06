import { stripVTControlCharacters } from "node:util";

/**
 * Convert terminal-oriented text into stable plain text suitable for Markdown.
 * Bare carriage returns are treated as line replacements, which removes most
 * progress-bar and spinner noise without reproducing terminal wrapping.
 */
export function sanitizeTerminalOutput(input: string): string {
  const withoutAnsi = stripVTControlCharacters(input).replaceAll("\r\n", "\n");
  const logicalLines = withoutAnsi.split("\n").map((line) => {
    const lastCarriageReturn = line.lastIndexOf("\r");
    const visible = lastCarriageReturn >= 0 ? line.slice(lastCarriageReturn + 1) : line;

    let result = "";
    for (const character of visible) {
      if (character === "\b") {
        result = result.slice(0, -1);
        continue;
      }
      const code = character.charCodeAt(0);
      if ((code < 0x20 && character !== "\t") || code === 0x7f) continue;
      result += character;
    }
    return result;
  });

  return logicalLines.join("\n");
}

export function markdownFence(content: string, language = ""): string {
  const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  return `${fence}${language}\n${normalized}${fence}`;
}

export function markdownLinkPath(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
