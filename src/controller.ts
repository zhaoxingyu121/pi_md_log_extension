/**
 * Per-session state and append orchestration for pi-md-log.
 *
 * Binding model (per design-review.md v2):
 * - A Markdown file is bound to a *session* (identified by its session file).
 * - `/log-bind` records only content that appears *after* binding (forward
 *   pointer, never backfills). `/log-export` appends the whole active branch.
 * - Forks never inherit the binding: restored state is validated against the
 *   current session file.
 * - Tree navigation deactivates auto-append; the user rebinds to continue.
 * - The Markdown file is user-owned notes: the extension only appends and
 *   never rewrites or scans existing content (no anchors, no gap filling).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  exportSegmentHeading,
  logFileHeader,
  renderEntries,
  type LogEntry,
  type LogMessageLike,
  type LogOptions,
} from "./render.ts";

export const LOG_STATE_TYPE = "pi-md-log-state";
export const LOG_VERSION_HEADER = "pi-md-log:1";

interface LogState {
  /** Absolute Markdown path this session is bound to. */
  mdPath: string;
  /** Session file the binding belongs to (fork-inheritance guard). */
  sessionFile?: string;
  /** Auto-append enabled? Disabled by tree navigation. */
  active: boolean;
  /** Leaf entry id at bind time (never backfill before this). */
  boundAtEntryId: string;
  /** Last entry id already appended to the file (forward pointer). */
  lastEntryId: string;
}

interface StoredEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp?: string | number;
  customType?: string;
  data?: unknown;
  message?: unknown;
  summary?: string;
  tokensBefore?: number;
}

const DEFAULT_LOG_OPTIONS: LogOptions = {
  includeThinking: false,
  includeBashExecution: false,
};

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function sameFile(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function unwrapArgument(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

export class LogController {
  private readonly pi: ExtensionAPI;
  private ctx: ExtensionContext | undefined;
  private state: LogState | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  /** Serialize file/state mutations so event handlers cannot interleave. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ---- session lifecycle -------------------------------------------------

  async start(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    this.state = undefined;
    const restored = this.loadState(ctx);
    if (!restored) return;
    this.state = restored;
    this.setStatus(ctx);
    if (restored.active) {
      if (ctx.hasUI) ctx.ui.notify(`已恢复 md 记录:${restored.mdPath}`, "info");
    } else if (ctx.hasUI) {
      ctx.ui.notify(`md-log 已恢复,处于暂停状态(/tree 切过节点)— /log-bind to rebind`, "info");
    }
  }

  /** Pick the newest pi-md-log state on the *current* path and validate it. */
  private loadState(ctx: ExtensionContext): LogState | undefined {
    const path = this.currentPath(ctx);
    const sessionFile = ctx.sessionManager.getSessionFile();
    for (let index = path.length - 1; index >= 0; index--) {
      const entry = path[index] as StoredEntry;
      if (entry.type !== "custom" || entry.customType !== LOG_STATE_TYPE) continue;
      const data = (entry.data ?? {}) as Partial<LogState> & { unbound?: boolean };
      // Tombstone written by /log-unbind: the binding is cancelled for good.
      if (data.unbound === true) return undefined;
      if (typeof data.mdPath !== "string" || !data.mdPath) continue;
      // Fork/clone copies state entries into the new session file, but the
      // binding belongs to the *source* session — drop it (decision D4).
      if (data.sessionFile && sessionFile && data.sessionFile !== sessionFile) continue;
      return {
        mdPath: data.mdPath,
        sessionFile,
        active: data.active !== false,
        boundAtEntryId: typeof data.boundAtEntryId === "string" ? data.boundAtEntryId : "",
        lastEntryId: typeof data.lastEntryId === "string" ? data.lastEntryId : "",
      };
    }
    return undefined;
  }

  private persistState(): void {
    const state = this.state;
    if (!state || !this.ctx) return;
    this.pi.appendEntry<LogState>(LOG_STATE_TYPE, {
      mdPath: state.mdPath,
      sessionFile: this.ctx.sessionManager.getSessionFile(),
      active: state.active,
      boundAtEntryId: state.boundAtEntryId,
      lastEntryId: state.lastEntryId,
    });
  }

  /** Entries on the active branch in chronological order (root -> leaf). */
  private currentPath(ctx: ExtensionContext): StoredEntry[] {
    const manager = ctx.sessionManager;
    const out: StoredEntry[] = [];
    let id: string | null | undefined = manager.getLeafId();
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const entry = manager.getEntry(id);
      if (!entry) break;
      out.push(entry as unknown as StoredEntry);
      id = entry.parentId;
    }
    return out.reverse();
  }

  // ---- commands ----------------------------------------------------------

  async bind(ctx: ExtensionContext, rawPath: string): Promise<boolean> {
    const mdPath = this.resolveTarget(ctx, rawPath);
    if (!mdPath) {
      if (ctx.hasUI) ctx.ui.notify("/log-bind 需要一个 md 文件路径", "warning");
      return false;
    }
    const manager = ctx.sessionManager;
    const leafId = manager.getLeafId();
    const entryId = leafId ?? ""; // "" = empty session: everything that follows is new

    const state: LogState = {
      mdPath,
      sessionFile: manager.getSessionFile(),
      active: true,
      boundAtEntryId: entryId,
      lastEntryId: entryId,
    };

    return this.enqueue(async () => {
      this.state = state;
      this.ctx = ctx;
      await this.ensureFile(ctx, mdPath);
      this.persistState();
      this.setStatus(ctx);
      if (ctx.hasUI) ctx.ui.notify(`已绑定 md 记录(仅记录之后的内容):${mdPath}`, "info");
      return true;
    });
  }

  /**
   * /log-unbind: stop auto-append AND forget the binding (path, pointer).
   * Writes a tombstone state entry so /resume or /reload never restore it.
   */
  async unbind(ctx: ExtensionContext): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.state) {
        if (ctx.hasUI) ctx.ui.notify("当前会话没有 md 绑定", "warning");
        return false;
      }
      const hadActive = this.state.active;
      const mdPath = this.state.mdPath;
      this.ctx = ctx;
      this.pi.appendEntry(LOG_STATE_TYPE, { unbound: true, mdPath: "" });
      this.state = undefined;
      this.setStatus(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(
          hadActive
            ? `已取消 md 绑定并停止记录:${mdPath}`
            : `已取消 md 绑定(此前处于暂停):${mdPath}`,
          "info",
        );
      }
      return true;
    });
  }

  async exportLog(ctx: ExtensionContext, rawPath: string | undefined): Promise<boolean> {
    const mdPath = this.resolveTarget(ctx, rawPath ?? this.state?.mdPath ?? "");
    if (!mdPath) {
      if (ctx.hasUI) ctx.ui.notify("/log-export 需要一个 md 文件路径(或先 /log-bind)", "warning");
      return false;
    }
    const entries = this.currentPath(ctx);
    if (entries.length === 0) {
      if (ctx.hasUI) ctx.ui.notify("当前会话还没有可导出的内容", "warning");
      return false;
    }
    const body = renderEntries(entries.map(toLogEntry), DEFAULT_LOG_OPTIONS);
    if (!body) {
      if (ctx.hasUI) ctx.ui.notify("当前分支没有可记录的内容(工具/终端消息默认不记录)", "warning");
      return false;
    }

    const manager = ctx.sessionManager;
    return this.enqueue(async () => {
      const created = await this.ensureFile(ctx, mdPath);
      const heading = exportSegmentHeading(manager.getSessionId(), manager.getSessionName() ?? undefined);
      await this.appendBody(mdPath, created ? body : `${heading}\n\n${body}`);
      // Keep bind's forward pointer in sync when exporting to the bound file so
      // the two paths never double-write the same entries.
      if (this.state && sameFile(this.state.mdPath, mdPath) && this.ctx) {
        const last = this.currentPath(this.ctx).at(-1);
        if (last) {
          this.state.lastEntryId = last.id;
          this.persistState();
        }
      }
      if (ctx.hasUI) ctx.ui.notify(`已导出到:${mdPath}`, "info");
      return true;
    });
  }

  // ---- events ------------------------------------------------------------

  /** agent_settled: append whatever appeared since the pointer. */
  async settled(ctx: ExtensionContext): Promise<void> {
    if (!this.isActive()) return;
    await this.appendSincePointer(ctx);
  }

  /** session_compact: append compaction fold blocks promptly. */
  async compacted(ctx: ExtensionContext): Promise<void> {
    if (!this.isActive()) return;
    await this.appendSincePointer(ctx);
  }

  /** session_tree: switching nodes deactivates auto-append (never mixes branches).
   *
   * Pi appends its own "Navigated to selected point" status line right after
   * this event. Both this extension's notice and Pi's hint share the same
   * single status slot (later showStatus overwrites the earlier one), so we
   * deliberately overwrite Pi's hint with a combined two-line message after
   * the tree overlay has closed.
   */
  async treeChanged(ctx: ExtensionContext): Promise<void> {
    if (!this.state?.active) return;
    const mdPath = this.state.mdPath;
    await this.enqueue(async () => {
      if (!this.state?.active) return;
      this.state.active = false;
      this.persistState();
      this.setStatus(ctx);
    });
    if (ctx.hasUI) {
      this.scheduleSuspendedNotice(ctx, mdPath, 300);
    }
  }

  /** Replace Pi's tree hint with a combined notice once the overlay closes. */
  private scheduleSuspendedNotice(ctx: ExtensionContext, mdPath: string, delayMs: number): void {
    setTimeout(() => {
      if (!this.state || this.state.mdPath !== mdPath) return; // rebound or unbound
      if (this.state.active) return; // already resumed
      if (!ctx.hasUI) return;
      ctx.ui.notify(
        "Navigated to selected point\nmd-log is suspended, /log-bind to rebind",
        "info",
      );
    }, delayMs);
  }

  async shutdown(): Promise<void> {
    await this.chain;
    this.state = undefined;
    this.ctx = undefined;
  }

  // ---- internals ---------------------------------------------------------

  private isActive(): boolean {
    return this.state?.active === true && this.ctx !== undefined;
  }

  private resolveTarget(ctx: ExtensionContext, raw: string): string | undefined {
    const path = unwrapArgument(raw);
    if (!path) return undefined;
    const expanded = expandHome(path);
    return isAbsolute(expanded) ? expanded : resolve(ctx.cwd, expanded);
  }

  /** Create the file (with its one-time header) when it does not exist yet. */
  private async ensureFile(ctx: ExtensionContext, mdPath: string): Promise<boolean> {
    await mkdir(dirname(mdPath), { recursive: true });
    try {
      await access(mdPath);
      return false;
    } catch {
      const manager = ctx.sessionManager;
      const header = logFileHeader(manager.getSessionId(), this.title(ctx));
      await writeFile(mdPath, `${header}\n`, { encoding: "utf8", flag: "wx" }).catch(() => undefined);
      return true;
    }
  }

  private title(ctx: ExtensionContext): string {
    const name = ctx.sessionManager.getSessionName();
    if (name) return name;
    return `Pi 会话 ${ctx.sessionManager.getSessionId().slice(0, 8)}`;
  }

  private async appendBody(mdPath: string, body: string): Promise<void> {
    const normalized = `${body.trim().replace(/\n{3,}/g, "\n\n")}\n`;
    await appendFile(mdPath, `\n\n${normalized}`, { encoding: "utf8" });
  }

  /**
   * Append all content-bearing entries that appeared after the forward pointer
   * (and only after the bind point). Advances the pointer over every entry in
   * between — rendered or not — so a given entry is considered exactly once.
   */
  private appendSincePointer(ctx: ExtensionContext): Promise<void> {
    const state = this.state;
    if (!state || !state.active) return Promise.resolve();
    const path = this.currentPath(ctx);

    let start = path.findIndex((entry) => entry.id === state.lastEntryId);
    if (start < 0) {
      if (state.lastEntryId === "") {
        start = -1; // bound in an empty session: everything is new
      } else {
        // Stale pointer (bound branch no longer active). Fall back to the bind
        // point; if that is gone too, deactivate rather than guess.
        const boundAt = path.findIndex((entry) => entry.id === state.boundAtEntryId);
        if (boundAt < 0) {
          state.active = false;
          this.persistState();
          if (ctx.hasUI) ctx.ui.notify("md 记录指针失效,已暂停(/tree 后请重新 /log-bind)", "warning");
          return Promise.resolve();
        }
        start = boundAt;
      }
    }

    const tail = start + 1 < path.length ? path.slice(start + 1) : [];
    if (tail.length === 0) return Promise.resolve();

    const entries = tail.map(toLogEntry);
    const body = renderEntries(entries, DEFAULT_LOG_OPTIONS);
    const lastId = tail[tail.length - 1].id;

    return this.enqueue(async () => {
      if (body) {
        await this.ensureFile(ctx, state.mdPath);
        await this.appendBody(state.mdPath, body);
      }
      // Pointer always advances (even over unrendered entries) so we never
      // rescan the same entries.
      state.lastEntryId = lastId;
      this.persistState();
    });
  }

  private setStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (this.state?.active) {
      const name = this.state.mdPath.split(/[\\/]/).pop() ?? this.state.mdPath;
      ctx.ui.setStatus("pi-md-log", `md:${name}`);
    } else {
      ctx.ui.setStatus("pi-md-log", undefined);
    }
  }
}

function toLogEntry(raw: StoredEntry): LogEntry {
  const message = normalizeMessage(raw.message);
  const timestamp =
    typeof raw.timestamp === "number" ? new Date(raw.timestamp).toISOString() : raw.timestamp;
  return {
    id: raw.id,
    type: raw.type,
    timestamp,
    message,
    summary: typeof raw.summary === "string" ? raw.summary : undefined,
    tokensBefore: typeof raw.tokensBefore === "number" ? raw.tokensBefore : undefined,
  };
}

function normalizeMessage(message: unknown): LogMessageLike | undefined {
  if (!message || typeof message !== "object") return undefined;
  const source = message as Record<string, unknown>;
  const content = source.content;
  return {
    role: typeof source.role === "string" ? source.role : undefined,
    content: (content as LogMessageLike["content"]) ?? undefined,
    timestamp: typeof source.timestamp === "number" ? source.timestamp : undefined,
    toolCallId: typeof source.toolCallId === "string" ? source.toolCallId : undefined,
    toolName: typeof source.toolName === "string" ? source.toolName : undefined,
    isError: typeof source.isError === "boolean" ? source.isError : undefined,
    errorMessage: typeof source.errorMessage === "string" ? source.errorMessage : undefined,
    stopReason: typeof source.stopReason === "string" ? source.stopReason : undefined,
    command: typeof source.command === "string" ? source.command : undefined,
    output: typeof source.output === "string" ? source.output : undefined,
    exitCode: typeof source.exitCode === "number" ? source.exitCode : undefined,
    cancelled: typeof source.cancelled === "boolean" ? source.cancelled : undefined,
    excludeFromContext:
      typeof source.excludeFromContext === "boolean" ? source.excludeFromContext : undefined,
  };
}
