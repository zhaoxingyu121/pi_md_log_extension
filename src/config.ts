/**
 * pi-md-log settings.
 *
 * This is the single place to configure the extension: edit
 * `src/pi-md-log.config.json` (next to this file). Nothing is read from the
 * environment, and there is no settings command. A change takes effect on the
 * next session start (`/reload` or a new session).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LogOptions } from "./render.ts";

/** Name of the user-editable settings file (sits next to this module). */
export const LOG_CONFIG_FILE = "pi-md-log.config.json";

/** Absolute path of the settings file, for messages and docs. */
export function logConfigPath(): string {
  return fileURLToPath(new URL(`./${LOG_CONFIG_FILE}`, import.meta.url));
}

/**
 * Safety net used only when the config file is missing or unreadable. Keep it
 * in sync with `pi-md-log.config.json`; the config file is what users edit.
 */
const FALLBACK_LOG_OPTIONS: LogOptions = {
  includeThinking: false,
  includeBashExecution: false,
  outputMaxLines: 200,
  outputMaxBytes: 20480,
  outputHeadRatio: 0.4,
  commandMaxChars: 120,
  argumentsMaxChars: 4000,
  bashCommandMaxChars: 200,
};

/** Read the settings file, falling back to defaults if it cannot be parsed. */
export function loadLogOptions(): LogOptions {
  try {
    const parsed: unknown = JSON.parse(readFileSync(logConfigPath(), "utf8"));
    if (parsed && typeof parsed === "object") {
      return { ...FALLBACK_LOG_OPTIONS, ...(parsed as Partial<LogOptions>) };
    }
  } catch {
    // Missing / invalid JSON: fall through to defaults.
  }
  return { ...FALLBACK_LOG_OPTIONS };
}
