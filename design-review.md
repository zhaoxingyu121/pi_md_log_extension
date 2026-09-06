# pi_md_log_extension 设计调研 v2

调研对象:官方 `docs/extensions.md` / `sessions.md` / `session-format.md` / `compaction.md`(pi 0.84.4,本地副本 `extensions.md`),
参考实现:`/root/programs/pi_md_forward`(已解决渲染、原子写、ANSI/围栏清理、/tree、/fork 分离等子问题)。

## 1. 结论摘要

- 方案**可行**,pi 提供全部所需钩子:命令(`pi.registerCommand`)、树导航事件(`session_tree`)、状态持久化(`pi.appendEntry`,custom 条目)、权威数据源(`ctx.sessionManager` JSONL 条目树)。
- 核心机制确定为:**基于 (sessionId, entryId) 的幂等增量追加**,HTML 注释锚点。md 以用户编辑为准,JSONL 只作为增量来源。
- 导出语义确定为:**原始历史全量**(类似 fork),即 leaf→root 路径上的 message **和** compaction/branch_summary 折叠块都导出;旧消息被压缩后仍在 JSONL 中,不会丢。

## 2. 已拍板决策(需求方确认)

| # | 决策 |
|---|------|
| D1 | **导出内容**:压缩前的旧消息 **与** 压缩内容(compaction 摘要)都导出(类似 fork 的完整历史) |
| D2 | **自动记录(bind 模式)**:compaction 发生时,压缩折叠块也正常追加进 md |
| D3 | **绑定归属**:md 绑定在 **Session** 上(以 session 文件为身份) |
| D4 | **fork 不继承绑定**:每个 session 需用户手动绑定;不同 session **可以**绑定同一个 md 文件 |
| D5 | **bind 不补历史**:`/log-bind` 只记录绑定之后新发生的内容;历史内容经 `/log-export` 一次性追加 |
| D6 | **不做 `--full` 整文件重建**(理由见 §5 决议) |

由 D3/D4 推出的工程约束:绑定状态里必须记录 session 文件身份,恢复时校验;同一 md 被多 session 绑定 → 锚点按 session 分区、去重只在同 session 内进行。

## 3. 关键事实(来自文档)

### 3.1 会话树形态与"回合"
- JSONL 每条记录是一个 entry,`id`(8 hex)+ `parentId` 构成树;当前位置 = leaf。
- entry 类型:`session`(头,不在树中)、`message`(role: user/assistant/toolResult)、`bash_execution`(`!`/`!!` 命令)、`custom`、`custom_message`、`compaction`、`branch_summary`、`model_change`、`thinking_level_change`、`label`、`session_info`。
- 一个"回合(turn)"= 一条 user message 起到下一条 user message 前(含其中的 assistant/toolResult/compaction/branch_summary)。pi 的压缩切点即按此回合定义。

### 3.2 压缩不改写历史
- compaction 只是**在树上追加**一条 `compaction` 条目(summary + `firstKeptEntryId`,新版含 `retainedTail`);之后 LLM 上下文从该边界重建,**旧 message 条目仍在 JSONL 里**,leaf→root 路径仍能走到。
- `/tree` 离开分支可生成 `branch_summary` 条目,同样在路径上。
- ⇒ 全量导出只需**遍历 leaf→root 路径并渲染每一种内容型 entry**,无需专门"恢复"被压缩的内容。

### 3.3 可用 API
- 读取:`getEntries()`、`getBranch(fromId?)`(路径)、`getLeafId()`/`getLeafEntry()`、`getEntry(id)`、`buildContextEntries()`(压缩生效后的视角,本设计不用它做全量导出)。
- **AssistantMessage/AgentMessage 不含 entry id**;id 在 `SessionMessageEntry` 外层 ⇒ 锚点必须从 sessionManager 取,不能从事件 payload 拿。
- 事件:`agent_settled`(整轮结束、空闲)、`turn_end`(带最终 message)、`session_tree{newLeafId,oldLeafId}`、`session_compact`、`session_shutdown` + `session_start{reason: startup|new|resume|fork|reload}`(这些 reason 会整体重载扩展;/tree 不会)。
- 命令:`pi.registerCommand(name,{description,handler(args,ctx),getArgumentCompletions})`;与内置 `/export`(HTML)等不冲突,同名自动 `:N` 后缀。
- 状态:`pi.appendEntry(customType,data)` 写 custom 条目,不进 LLM 上下文;`session_start` 时遍历可恢复。

## 4. 兼容性风险与对策

| # | 风险 | 对策 |
|---|------|------|
| 1 | message_end 后其它扩展仍可整体替换 message;事件触发时 entry 未必已落库(仅 tool_call 有 drain 保证) | 自动记录不在事件 payload 上做,而在**安全时点从 sessionManager 对账**(`agent_settled`,可加 `turn_end`/下次 `input` 兜底),遍历 leaf→root 找未导出的内容追加 |
| 2 | auto-retry / auto-compact+retry 重放内容 | (sessionId, entryId) 锚点幂等,同一条目只导出一次 |
| 3 | /tree 跳分支后自动续写会把多个分支混进同一 md | `session_tree` 中 newLeafId 相对上次导出的 leaf 变化 → 关闭自动 + notify,由用户重新 `/log-bind` 或 `/log-export`(符合原需求 2) |
| 4 | fork/clone/new/resume 整 session 重载;custom 状态若被 fork 复制会"继承绑定" | 状态记录 `sessionFile`;`session_start` 恢复时校验 `sessionFile === 当前文件`,不等即视为无绑定(D4)。new/resume/fork/clone 默认清空绑定,提示手动绑定 |
| 5 | 多 session 绑同一 md,或用户外部编辑 | 锚点带 sessionId,追加时若 md 中记录的上一个 session ≠ 当前,先写**分区标题**(`## Session: ...`),同 session 内按 (id) 去重,跨 session 不去重(D3/D4 的必然结果:共享前缀会在各自分区出现一次) |
| 6 | 反引号围栏、ANSI、base64 图片、超长输出 | 复用 pi_md_forward 的清理/围栏安全/截断+sidecar;图片默认跳过或转存 assets(见 P 待定) |
| 7 | /reload 重载丢内存状态、重复导出 | 状态入 custom 条目(session 内)或 sidecar;锚点幂等保证不重复 |
| 8 | 其它扩展的 markdown transformer 只影响终端渲染 | 插件直接读写原始 message 文本,互不干扰 |
| 9 | rpc/json/print 无交互 UI | 命令仅交互;自动记录无 UI 也可;省略路径时用 `ctx.ui.input` 需先查 `ctx.hasUI` |
| 10 | 两进程同时写同一 md | 单进程内写队列串行 + 原子写(tmp+rename);跨进程并发声明为不支持 |

## 5. 架构设计 v2

```
绑定状态(per session):{ sessionFile, mdPath, boundAtEntryId?, 选项 }
  boundAtEntryId: 绑定时刻的 leaf entry id —— 对账时只处理它之后追加的单元,从机制上保证 bind 不补历史(D5)
  存储: pi.appendEntry("pi-md-log", state)  —— 恢复时校验 sessionFile;
        可选 sidecar(见 P4)。fork 因 sessionFile 不同天然不继承(D4)。

导出单元: 一个"回合"(user message 及其后续到下一 user message 前)
锚点格式: <!-- pi-md-log:start:<sessionId>:<entryId> --> ... <!-- pi-md-log:end:<sessionId>:<entryId> -->
          sessionId = session header 的 uuid(或文件路径 hash)

渲染规则(leaf→root 全量遍历):
  message(user/assistant) → 正常 md 区块
  message(toolResult)     → 默认跳过/折叠(P1)
  bash_execution          → 默认跳过/折叠(P1)
  compaction              → 折叠引用块:
                             "> 🔗 上下文压缩(此前 N tokens): <summary>"
                             其"前面"的旧消息在同一次遍历中原样导出(JSONL 保留,无需恢复)
  branch_summary          → 同上风格折叠块(离开分支的摘要)
  custom / label / model_change / ... → 不导出

自动记录(bind 模式):
  触发时点: agent_settled(整轮完成),以及 session_compact / session_tree 之后各一次对账
  动作:     遍历 leaf→root,只处理**位于 boundAtEntryId 之后**的单元(D5:不补历史);
            凡 (sessionId, entryId) 锚点尚未出现在 md 中,按路径顺序追加到文件尾部
            → 压缩发生后,折叠块与后续新消息正常追加(D2);
              用户删除/批注/重排 md 均安全,不补回已删内容
  关闭条件: session_tree 换分支 / session 切换(fork/new/resume)→ 关自动 + notify

命令:
  /log-bind [path]     绑定 md 并开启自动记录;**只记录绑定之后新发生的内容,不补历史**(D5)
  /log-export [path]   把当前 leaf→root 的内容型单元(含压缩折叠块,类似 fork 的全历史)作为一段
                       **直接追加**:文件不存在 → 建文件并全量写入;文件存在 → 直接追加到末尾,
                       **不做锚点补齐**(不扫描文件里已有哪些锚点、不填缺口)
  (可选) /log          别名 = bind + export(两者语义需连用时的便捷组合)
  不做 --full(D6);需要"重建"时用户删除/改名文件后 /log-export 即可

> 语义注意:export 追加的单元仍带锚点,但**不检查文件内是否已存在** ——
> 对同一文件重复执行 /log-export 会重复追加整段内容(手动命令,由用户管理文件);
> 若同文件开启了 bind,其自动对账会用锚点幂等去重,不会因 export 产生额外重复。

事件接线:
  session_start   → 读 custom 状态,校验 sessionFile;reason∈{new,resume,fork} 时绑定清空(D4)
  session_compact → 对账一次(把折叠块写进 md,D2)
  session_tree    → leaf 变化:关自动 + notify
  agent_settled   → 对账(bind 开启时)
  session_shutdown→ 兜底 flush
```

### 状态存储细节(fork 不继承的关键)
- 每 session 至多一个有效 custom 状态条目:取当前 leaf→root 路径上**最新**的 `pi-md-log` 条目,且要求其 `data.sessionFile === ctx.sessionManager.getSessionFile()`。
- fork/clone 即便把旧 custom 条目复制进新 session,因 sessionFile 不匹配会被忽略 → 新 session 表现为未绑定,符合 D4。
- 同一 session 内换绑(mdPath 变更):追加新状态条目即可,旧条目留在旧分支不影响。

## 6. 剩余待拍板(P 项)

- **P1** 工具消息(toolResult/bash 输出/tool_call 参数)与 **thinking 块**的记录策略:
  默认建议:thinking 不记;toolResult 折叠成 `<details>`,默认折叠;**bash 输出默认不记**,`!`/`!!` 的 bash_execution 可选。
- **P2** 图片:默认跳过 / 转存 md 旁 `assets/` 并相对引用 / 内嵌 data URI(会很大)。
- **P3** 记录粒度:回合级(推荐,agent_settled 一次追加)。超长回合(tool 循环多)是否在 `turn_end` 追加半成品——建议只在 agent_settled 收尾,避免半成品污染笔记。
- **P4** 绑定状态存放:custom 条目(推荐,随 session、天然跨 /reload//resume)vs md 旁 sidecar JSON(用户把 md 拷走时状态不迁移)。
- **P5** 分区标题格式与策略:`## Session: <session 名/时间>`(默认)是否可关;跨 session 追加同一 md 时是否要求显式确认。
- **P6(已定 D6)** 不做 `--full`,理由见下方决议。
- **P7(已定 D5)** bind 不补历史,无 `--no-history` 选项;命令参数自动补全(文件路径)仍建议做。

### 关于 --full 的决议(D6)

不做整文件重建命令,因为:

- md 是用户笔记,全量重建会覆盖批注与删除,与"md 以用户为准"的核心契约冲突;
- 锚点幂等增量已覆盖全部"同步/补齐"需求;唯一真实的全量场景是渲染格式升级,罕见;
- 等价替代天然存在且更安全:**删除/改名 md 文件后 `/log-export`**(文件不存在时自然整文件写入),删除动作即用户最明确的确认;
- 防御未来格式变更:文件头写 `<!-- pi-md-log:version:N -->`,检测到旧版本时提示用户自行决定重建,绝不自动覆盖。

## 7. 建议参考实现
- `/root/programs/pi_md_forward/src/index.ts`:ANSI 清理、反引号围栏安全、原子写、/tree 重建、fork/clone 分文件——直接复用其渲染/IO 层,替换"整文件重建"为 v2 的"(sessionId, entryId) 幂等增量追加"。
