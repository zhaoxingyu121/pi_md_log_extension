/**
 * pi-md-log: append-only Markdown note logger for Pi sessions.
 *
 * Commands:
 *   /log-bind <path>   Bind this session to a Markdown file and start
 *                      recording. Records ONLY content that appears after the
 *                      bind — it never backfills history.
 *   /log-export <path> Append the whole active branch (user/assistant turns,
 *                      compaction fold blocks) to <path>. Existing files are
 *                      appended to without any scanning or deduplication; a
 *                      missing file is created with a header first.
 *   /log-unbind        Stop auto-append and forget the binding permanently.
 *
 * Behavior:
 *   - Binding lives on the session file; forks/clones never inherit it.
 *   - Tree navigation pauses auto-append (no branch mixing). Rebind to resume.
 *   - The Markdown file is user-owned notes: pi-md-log only appends and never
 *     rewrites existing content.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LogController } from "./controller.ts";

export default function piMdLog(pi: ExtensionAPI): void {
  let controller: LogController | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (controller) await controller.shutdown();
    controller = new LogController(pi);
    await controller.start(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await controller?.settled(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    await controller?.compacted(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await controller?.treeChanged(ctx);
  });

  pi.on("session_shutdown", async () => {
    await controller?.shutdown();
    controller = undefined;
  });

  pi.registerCommand("log-bind", {
    description: "绑定本会话到 md 笔记文件并开始记录(只记之后的内容)",
    handler: async (args, ctx) => {
      if (!controller) return;
      await controller.bind(ctx, args);
    },
  });

  pi.registerCommand("log-export", {
    description: "把当前分支全部内容追加到 md 文件(存在则直接追加,不存在则新建)",
    handler: async (args, ctx) => {
      if (!controller) return;
      const raw = args.trim();
      await controller.exportLog(ctx, raw || undefined);
    },
  });

  pi.registerCommand("log-unbind", {
    description: "取消本会话的 md 绑定:停止自动记录并忘记绑定文件(/resume 不再恢复)",
    handler: async (_args, ctx) => {
      if (!controller) return;
      await controller.unbind(ctx);
    },
  });
}
