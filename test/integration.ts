/**
 * Standalone integration checks for pi-md-log semantics, run without pi:
 *
 *   node test/integration.ts
 *
 * Verifies (per design-review.md v2):
 *   1. /log-export to a missing file creates it with a header and appends the
 *      whole branch.
 *   2. /log-export to an existing file appends directly (duplicates allowed,
 *      no scanning).
 *   3. /log-bind never backfills: only content appearing after the bind point
 *      is appended.
 *   4. Bind advances a forward pointer: repeated settles append each entry once.
 *   5. /tree deactivates auto-append; settled() then writes nothing.
 *   6. Export to the bound file moves the pointer so bind does not double-write.
 *   7. Forked sessions (different session file, copied state) never inherit a
 *      binding.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LogController, LOG_STATE_TYPE } from "../src/controller.ts";
import { renderEntries, type LogOptions } from "../src/render.ts";
import { loadLogOptions, logConfigPath } from "../src/config.ts";

interface StoredEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
  summary?: string;
  tokensBefore?: number;
}

class FakeSessionManager {
  entries: StoredEntry[] = [];
  sessionFile: string;
  sessionId: string;
  sessionName?: string;
  private counter = 0;

  constructor(sessionFile: string) {
    this.sessionFile = sessionFile;
    this.sessionId = `uuid-${sessionFile.replace(/\W/g, "")}`;
  }

  private nextId(): string {
    this.counter += 1;
    return `id${this.counter}`;
  }

  append(entry: Omit<StoredEntry, "id" | "parentId" | "timestamp">): string {
    const id = this.nextId();
    const parentId = this.entries.length ? this.entries[this.entries.length - 1].id : null;
    this.entries.push({ ...entry, id, parentId, timestamp: new Date().toISOString() });
    return id;
  }

  appendUser(text: string): string {
    return this.append({ type: "message", message: { role: "user", content: text, timestamp: Date.now() } });
  }

  appendAssistant(text: string): string {
    return this.append({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
        stopReason: "stop",
      },
    });
  }

  appendCompaction(summary: string): string {
    return this.append({ type: "compaction", summary, tokensBefore: 50_000 });
  }

  appendState(data: unknown): void {
    this.append({ type: "custom", customType: LOG_STATE_TYPE, data });
  }

  getLeafId(): string | null {
    return this.entries.length ? this.entries[this.entries.length - 1].id : null;
  }

  getEntry(id: string): StoredEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionName(): string | undefined {
    return this.sessionName;
  }
}

interface FakePi {
  appendEntry: (customType: string, data: unknown) => void;
}

function makePi(manager: FakeSessionManager): FakePi {
  return {
    appendEntry(customType: string, data: unknown) {
      // Mirrors real pi: state entries are appended at the current leaf.
      manager.appendState(customType === LOG_STATE_TYPE ? data : { customType, data });
    },
  };
}

interface UiSpy {
  notifies: Array<{ text: string; level: string }>;
  statuses: Map<string, string | undefined>;
}

function makeUi(spy?: UiSpy) {
  if (!spy) {
    return {
      notify: () => undefined,
      setStatus: () => undefined,
    };
  }
  return {
    notify: (text: string, level: string) => {
      spy.notifies.push({ text, level });
    },
    setStatus: (id: string, value: string | undefined) => {
      spy.statuses.set(id, value);
    },
  };
}

function makeCtx(manager: FakeSessionManager, spy?: UiSpy): ExtensionContext {
  return {
    cwd: "/work",
    hasUI: spy !== undefined,
    ui: makeUi(spy),
    sessionManager: manager as never,
  } as unknown as ExtensionContext;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lines(file: string): string[] {
  return readFileSync(file, "utf8").replace(/\n$/, "").split("\n");
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-md-log-test-"));
  try {
    // ---------------------------------------------------------------- export
    {
      const mgr = new FakeSessionManager(join(dir, "a.jsonl"));
      const controller = new LogController(makePi(mgr) as never);
      const ctx = makeCtx(mgr);
      await controller.start(ctx);

      const file = join(dir, "notes.md");
      mgr.appendUser("Q1");
      mgr.appendAssistant("A1");
      mgr.appendCompaction("earlier context was summarized");
      mgr.appendUser("Q2");
      mgr.appendAssistant("A2");

      const ok = await controller.exportLog(ctx, file);
      assert(ok, "export created the file");
      const content = readFileSync(file, "utf8");
      assert(content.includes("<!-- pi-md-log:1:session="), "file header comment present");
      assert(content.includes("Q1") && content.includes("A1"), "whole branch exported (Q1/A1)");
      assert(content.includes("Q2") && content.includes("A2"), "whole branch exported (Q2/A2)");
      assert(content.includes("Context compacted"), "compaction fold exported");
      assert(content.includes("earlier context was summarized"), "compaction summary exported");
      const before = lines(file).length;
      await controller.exportLog(ctx, file);
      const after = lines(file).length;
      assert(after > before, "export to existing file appends directly");
      console.log("  ✓ export: create + append whole branch incl. compaction; re-export appends again");
    }

    // ------------------------------------------------- bind: no backfill
    {
      const mgr = new FakeSessionManager(join(dir, "b.jsonl"));
      const controller = new LogController(makePi(mgr) as never);
      const ctx = makeCtx(mgr);
      await controller.start(ctx);

      mgr.appendUser("old Q");
      mgr.appendAssistant("old A");
      const file = join(dir, "bind.md");

      // Bind now: history (old Q/A) must NOT be backfilled.
      await controller.bind(ctx, file);
      await controller.settled(ctx);
      let content = readFileSync(file, "utf8");
      assert(!content.includes("old Q") && !content.includes("old A"), "bind never backfills history");
      assert(content.includes("<!-- pi-md-log:1:session="), "bind created the file header");

      // New messages after bind are recorded.
      mgr.appendUser("new Q");
      mgr.appendAssistant("new A");
      await controller.settled(ctx);
      content = readFileSync(file, "utf8");
      assert(content.includes("new Q") && content.includes("new A"), "content after bind is recorded");
      assert(!content.includes("old Q"), "history still absent after settle");

      // Forward pointer: settling again with no new entries appends nothing.
      const before = lines(file).length;
      await controller.settled(ctx);
      const after = lines(file).length;
      assert(after === before, "no duplicate on repeated settle");
      console.log("  ✓ bind: no backfill; forward pointer; no duplicates on repeated settle");
    }

    // ------------------------------------------------- bind + compaction live
    {
      const mgr = new FakeSessionManager(join(dir, "c.jsonl"));
      const controller = new LogController(makePi(mgr) as never);
      const ctx = makeCtx(mgr);
      await controller.start(ctx);

      const file = join(dir, "live.md");
      await controller.bind(ctx, file);
      mgr.appendUser("q");
      mgr.appendAssistant("partial answer");
      mgr.appendCompaction("mid-run context was compacted");
      await controller.compacted(ctx);
      let content = readFileSync(file, "utf8");
      assert(content.includes("partial answer"), "turn prefix appended");
      assert(content.includes("mid-run context was compacted"), "compaction fold appended promptly");
      mgr.appendAssistant("final answer");
      await controller.settled(ctx);
      content = readFileSync(file, "utf8");
      assert(content.includes("final answer"), "rest of the turn appended after settle");
      const occurrences = content.split("Context compacted").length - 1;
      assert(occurrences === 1, "compaction fold not duplicated after settle");
      console.log("  ✓ compaction mid-turn: fold appended once, tail follows on settle");
    }

    // ------------------------------------------------- /tree deactivates bind
    {
      const mgr = new FakeSessionManager(join(dir, "d.jsonl"));
      const controller = new LogController(makePi(mgr) as never);
      const ctx = makeCtx(mgr);
      await controller.start(ctx);

      const file = join(dir, "tree.md");
      await controller.bind(ctx, file);
      mgr.appendUser("q1");
      mgr.appendAssistant("a1");
      await controller.settled(ctx);
      await controller.treeChanged(ctx);
      mgr.appendUser("q2");
      mgr.appendAssistant("a2");
      await controller.settled(ctx);
      const content = readFileSync(file, "utf8");
      assert(content.includes("a1") && !content.includes("a2"), "/tree pauses auto-append");
      console.log("  ✓ /tree switch pauses recording; later content not appended");
    }

    // --------------------------------- /tree shows visible pause feedback (UI)
    {
      const spy: UiSpy = { notifies: [], statuses: new Map() };
      const mgr = new FakeSessionManager(join(dir, "d2.jsonl"));
      const controller = new LogController(makePi(mgr) as never);
      const ctx = makeCtx(mgr, spy);
      await controller.start(ctx);

      const file = join(dir, "tree-ui.md");
      await controller.bind(ctx, file);
      mgr.appendUser("q1");
      mgr.appendAssistant("a1");
      await controller.settled(ctx);
      await controller.treeChanged(ctx);

      // No persistent footer while suspended.
      const status = spy.statuses.get("pi-md-log");
      assert(status === undefined, "no persistent footer while suspended");

      // After the tree overlay closes, Pi's own hint is deliberately replaced
      // by a combined two-line notice (single shared status slot).
      await sleep(600);
      const notices = spy.notifies.filter((entry) => entry.text.includes("md-log is suspended"));
      assert(notices.length === 1, "one combined suspended notice");
      assert(
        notices[0].text.includes("Navigated to selected point\nmd-log is suspended, /log-bind to rebind"),
        "notice keeps Pi's own hint text on its first line",
      );
      assert(notices[0].level === "info", "notice is info/muted");

      // Re-settling after that must not repeat the notice.
      mgr.appendUser("q2");
      mgr.appendAssistant("a2");
      await controller.settled(ctx);
      const again = spy.notifies.filter((entry) => entry.text.includes("md-log is suspended"));
      assert(again.length === 1, "notice is one-shot, not repeated");
      console.log("  ✓ /tree replaces Pi's hint with a combined two-line suspended notice");
    }

    // ------------------------------------------- export to bound file syncs pointer
    {
      const mgr = new FakeSessionManager(join(dir, "e.jsonl"));
      const controller = new LogController(makePi(mgr) as never);
      const ctx = makeCtx(mgr);
      await controller.start(ctx);

      const file = join(dir, "sync.md");
      await controller.bind(ctx, file);
      mgr.appendUser("q");
      mgr.appendAssistant("a");
      // Bind records the new message already, then export appends the whole
      // branch again and must move the pointer to the leaf.
      await controller.settled(ctx);
      await controller.exportLog(ctx, file);
      const before = lines(file).length;
      await controller.settled(ctx);
      const after = lines(file).length;
      assert(after === before, "export moved pointer: no bind/export overlap");
      console.log("  ✓ export to bound file syncs forward pointer");
    }

    // ------------------------------------------------- fork never inherits
    {
      const parent = new FakeSessionManager(join(dir, "parent.jsonl"));
      const parentController = new LogController(makePi(parent) as never);
      await parentController.start(makeCtx(parent));
      const file = join(dir, "fork.md");
      await parentController.bind(makeCtx(parent), file);
      parent.appendUser("q");
      parent.appendAssistant("a");
      await parentController.settled(makeCtx(parent));

      // Simulate /fork: new session file whose entries copy the parent's
      // branch *including* the state custom entry (same parentId chain).
      const fork = new FakeSessionManager(join(dir, "fork.jsonl"));
      for (const entry of parent.entries) {
        fork.append({ ...entry });
      }
      fork.sessionName = undefined;

      const forkController = new LogController(makePi(fork) as never);
      const forkCtx = makeCtx(fork);
      await forkController.start(forkCtx);
      // The restored state must be dropped (session file mismatch).
      fork.appendUser("fork q");
      fork.appendAssistant("fork a");
      await forkController.settled(forkCtx);
      const content = readFileSync(file, "utf8");
      assert(content.includes("fork a") === false, "forked session did not auto-write to the bound file");
      console.log("  ✓ fork does not inherit the binding (validated by session file)");
    }

    // ------------------------------------------------ /log-unbind cancels for good
    {
      const mgr = new FakeSessionManager(join(dir, "f.jsonl"));
      const controller = new LogController(makePi(mgr) as never);
      const ctx = makeCtx(mgr);
      await controller.start(ctx);

      const file = join(dir, "unbind.md");
      await controller.bind(ctx, file);
      mgr.appendUser("q");
      mgr.appendAssistant("a");
      await controller.settled(ctx);

      // Unbind: stop recording and forget the path.
      const ok = await controller.unbind(ctx);
      assert(ok, "unbind succeeded");
      mgr.appendUser("q2");
      mgr.appendAssistant("a2");
      await controller.settled(ctx);
      let content = readFileSync(file, "utf8");
      assert(content.includes("a") && !content.includes("a2"), "unbind stops auto-append");

      // Simulate restart on the same session file: the tombstone must prevent
      // the old binding from being restored.
      const restarted = new LogController(makePi(mgr) as never);
      await restarted.start(ctx);
      mgr.appendUser("q3");
      mgr.appendAssistant("a3");
      await restarted.settled(ctx);
      content = readFileSync(file, "utf8");
      assert(!content.includes("a3"), "binding is not restored after restart");
      console.log("  ✓ /log-unbind stops recording and survives restart (tombstone)");
    }

    // --------------------------------- tool rendering: de-duplicated summaries
    {
      const base: LogOptions = { ...loadLogOptions(), foldStyle: "details" };
      const body = renderEntries(
        [
          {
            id: "a1",
            type: "message",
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/render.ts", offset: 10, limit: 50 } },
                { type: "toolCall", id: "c2", name: "write", arguments: { path: "src/foo.ts", content: "export const x = 1;\n" } },
                { type: "toolCall", id: "c3", name: "edit", arguments: { path: "src/foo.ts", edits: [{ oldText: "a", newText: "b" }] } },
                { type: "toolCall", id: "c4", name: "bash", arguments: { command: "echo one\necho two" } },
              ],
            },
          },
          { id: "r1", type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: "line 10\nline 11" } },
          { id: "r2", type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "write", content: "ok" } },
          { id: "r3", type: "message", message: { role: "toolResult", toolCallId: "c3", toolName: "edit", content: "ok" } },
          { id: "r4", type: "message", message: { role: "toolResult", toolCallId: "c4", toolName: "bash", content: "one\ntwo" } },
        ],
        base,
      );

      assert(body.includes("<summary>🔧 read src/render.ts:10-60</summary>"), "read folds offset/limit into a range summary");
      assert(!body.includes('"offset"') && !body.includes('"limit"'), "read offset/limit not dumped as arguments");
      assert(body.includes("<summary>🔧 write src/foo.ts</summary>"), "write path is in the summary");
      assert(body.includes("**Content**") && body.includes("export const x = 1;"), "write content is folded");
      assert(body.includes("<summary>🔧 edit src/foo.ts</summary>"), "edit path is in the summary");
      assert(body.includes("**Old**") && body.includes("**New**"), "edit old/new text is folded");
      assert(body.includes("<summary>🔧 bash</summary>"), "multiline bash command folds to the bare tool name");
      assert(body.includes("**Command**") && body.includes("echo one\necho two"), "multiline bash command is folded");

      const open = body.indexOf("<details>");
      const close = body.indexOf("</details>");
      const result = body.indexOf("**Result**");
      assert(open >= 0 && result > open && result < close, "result stays hidden inside the fold");
      console.log("  ✓ tool render: read range; write/edit path in summary, long/multiline args folded; result hidden");
    }

    // ---------------------------------------- Obsidian fold style (callouts)
    {
      const obsidian: LogOptions = { ...loadLogOptions(), foldStyle: "obsidian" };
      const body = renderEntries(
        [
          {
            id: "a1",
            type: "message",
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", id: "c1", name: "read", arguments: { path: "a/b.ts", offset: 1, limit: 5 } },
              ],
            },
          },
          { id: "r1", type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: "one\ntwo" } },
        ],
        obsidian,
      );
      assert(body.includes("> [!note]- 🔧 read a/b.ts:1-6"), "obsidian mode uses a foldable callout title");
      assert(!body.includes("<details>") && !body.includes("<summary>"), "obsidian mode never emits <details>");
      assert(body.includes("> **Result**") && body.includes("> ``"), "callout body lines are quoted");
      console.log("  ✓ obsidian mode: callout folds, no <details> tags");
    }

    // -------------------------------------- configurable truncation settings
    {
      const options = loadLogOptions();
      assert(options.outputMaxLines > 0 && options.outputMaxChars > 0, "settings load from the config file");
      assert(logConfigPath().endsWith("pi-md-log.config.json"), "settings file is easy to locate");

      const long = Array.from({ length: options.outputMaxLines + 10 }, (_, index) => `line ${index}`).join("\n");
      const body = renderEntries(
        [{ id: "1", type: "message", message: { role: "toolResult", toolCallId: "x", content: long } }],
        { ...options, outputMaxLines: 5 },
      );
      assert(body.includes("Output truncated"), "configured budget truncates tool output");
      console.log("  ✓ truncation settings come from src/pi-md-log.config.json (no hardcoding)");
    }

    // -------------------- unified head+tail truncation for args and results
    {
      const opts: LogOptions = {
        ...loadLogOptions(),
        outputMaxLines: 100,
        outputMaxChars: 120,
        foldStyle: "details",
      };
      const longText = Array.from(
        { length: 40 },
        (_, index) => `line-${String(index).padStart(2, "0")}-${"x".repeat(20)}`,
      ).join("\n");

      const resultBody = renderEntries(
        [{ id: "r1", type: "message", message: { role: "toolResult", toolCallId: "x", toolName: "bash", content: longText } }],
        opts,
      );
      const argBody = renderEntries(
        [{
          id: "a1",
          type: "message",
          message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "x.py", content: longText } }] },
        }],
        opts,
      );

      for (const [label, body] of [
        ["result", resultBody],
        ["arguments", argBody],
      ] as const) {
        assert(body.includes("middle of text omitted"), `${label} is truncated by the shared char budget`);
        assert(body.includes("line-00") && body.includes("line-39"), `${label} keeps head and tail`);
        assert(!body.includes("line-20"), `${label} drops the middle`);
      }
      console.log("  ✓ unified truncation: same line+char head+tail budget for arguments and results");
    }

    console.log("\nAll integration checks passed.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
