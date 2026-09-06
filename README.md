# pi-md-log

把 Pi 会话的对话内容以**追加**方式同步到 Markdown 文件,作为**用户自己的笔记**:
可以用 Typora / Obsidian / VS Code 等打开,公式(LaTeX)与代码围栏原样保留、可自由编辑。

> 与 [`pi_md_forward`](../pi_md_forward) 的区别:它把 md 当「整文件重建的转录镜像」;
> 本插件把 md 当**用户笔记**——插件只在文件末尾追加,**绝不重写或扫描已有内容**。
> 设计规格见 [`design-review.md`](./design-review.md)。

## 命令

| 命令 | 语义 |
|---|---|
| `/log-bind <path>` | 绑定本会话到 md 文件并开始自动记录。**只记录绑定之后新发生的内容,不补历史**;文件不存在则先创建(带一行头注释) |
| `/log-export <path>` | 把当前分支全部内容(含压缩折叠块)作为一段**直接追加**;文件不存在则新建并全量写入,存在则追加到末尾。**不查重、不补齐**——重复执行会重复追加(手动命令,文件归你管理) |
| `/log-unbind` | **取消本会话的绑定**:停止自动记录并忘记绑定文件(/resume、/reload 都不会再恢复) |

> /tree「切到新节点后把整条分支写进文件并继续记录」= `/log-bind <path>` 后接 `/log-export`。

路径支持 `~` 与相对路径(相对当前工作目录解析)。

## 行为要点(对应设计决策)

- **绑定归属 Session**:绑定状态存为 session 内 custom 条目,恢复时校验 session 文件身份。
  - `/fork`、`/clone`、`/new` **不会继承绑定**;每个会话需手动绑定。
  - `/resume` 同一文件、`/reload`:自动恢复绑定并继续记录。
  - 不同会话**可以**绑定同一个 md(内容各自追加,不做跨会话去重)。
- **/tree 切换节点**:自动暂停记录(绝不把两个分支混进同一个文件)。pi 的「Navigated to selected point」与扩展提示共用同一条状态槽位(后者覆盖前者),因此合并为两行灰色提示覆盖:第一行保留 pi 原文,第二行为 `md-log is suspended, /log-bind to rebind`。
- **压缩(compaction)**:压缩折叠块(`> 📌 上下文压缩 …`)照常追加;旧消息仍在 JSONL 里,`/log-export` 会连同压缩前的旧消息一起导出(类似 fork 的全历史)。
- **前向指针**:bind 模式在状态里记录「最后已追加的 entry id」,单调追加、同一内容只写一次;不扫描 md,不做补全,不写任何锚点注释。
- **取消绑定**:`/log-unbind` 写入一个 tombstone 状态条目,之后 `/resume`、`/reload` 都不会恢复该绑定;再次 `/log-bind` 则从新指针开始(不补历史)。
- **导出到已绑定文件后**,插件会把指针同步到当前 leaf,避免 bind/export 双重写入。

## 记录内容默认值

- 用户消息 → `## Q · 时间` + 全文;助手回复 → 原文 Markdown(含 LaTeX)。
- **thinking 块默认不记录**;工具调用/结果折叠为 `<details>`(默认折叠,输出过长截断);
- `!`/`!!` 终端命令(`bashExecution`)默认不记录;
- 图片默认省略(仅标注数量)。

这些默认值定义在 `src/controller.ts` 的 `DEFAULT_LOG_OPTIONS`(以及 `src/render.ts` 的渲染逻辑),可自行调整。

## 安装试用

```bash
# 一次性试用
pi -e ./src/index.ts

# 常用:复制到项目本地自动加载(或 ~/.pi/agent/extensions/)
mkdir -p .pi/extensions && cp -r src .pi/extensions/pi-md-log
```

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node test/integration.ts(模拟 session,验证指针/bind/export/tree/fork 语义)
```

## 文件结构

```
src/index.ts        入口:事件接线 + 命令注册
src/controller.ts   状态(绑定/指针)与追加编排
src/render.ts       纯函数渲染(可单测)
src/sanitize.ts     终端输出清洗/反引号围栏安全(复用自 pi_md_forward)
src/truncate.ts     超长输出截断(复用自 pi_md_forward)
test/integration.ts 集成语义测试
design-review.md    设计规格(v2)
```
