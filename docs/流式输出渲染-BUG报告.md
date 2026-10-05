# 流式输出渲染 —— BUG 报告

> ## ⚠️ 历史文档
>
> 本文写于 **DSH 复刻页时代**，其中描述的垫片（`tools/replica-shim.js`）、
> `build-dsh-replica.mjs`、`plugins-src/`、`tsconfig.web.json` 等**都已经归档到
> `_attic/`**，路径不再存在。现在的架构见 `docs/架构-现状.md`。
>
> **不要照着本文去改代码** —— 它描述的那个前端已经不在了。


> 排查对象：`tools/replica-shim.js`（页面垫片，DSH 前端 ↔ 我们守护进程之间**唯一**的翻译层）
> 及其部署副本 `web/replica-shim.js`。
> 症状起点（用户原话）：「流式输出渲染有问题」→ 具体是**网页界面完全不流式：一直空着，
> 最后整段一次性蹦出来**。
>
> 复现件、怎么跑、有哪些坑：见 `.repro/README.md`。诊断口清单见本报告最后一节。

---

## 一、结论摘要

一共 **9 个真缺陷**，全部在垫片里（守护进程侧这一段实测是好的，见 §3.1 的对照）。
按"用户能不能看见"排序：

| # | 缺陷 | 用户看到什么 | 我引入的？ |
|---|---|---|---|
| **B1** | `step/start` 迟到（只在折到助手消息时才发） | **完全不流式：一直空着，最后整段蹦出来** | 既有 |
| **B2** | 用户消息把权威步号抹成 0 | 同一条回答**出现两遍**（无任何报错） | 既有 |
| **B3** | `sealJournal` 无条件收步 | 文字先正常流出来，**收尾时又整段被撤掉** | 既有 |
| **B4** | 在线尾巴晚于落盘的 `assistant/message` | 同 B3（两条不同的触发路径，同一个现象） | 既有 |
| **B5** | `tool/result` / `step/end` 挂错步号（挂到下一步） | trajectory 面板里工具返回、step 结束**跑到第二步下面**；客户端抛 `update before its start Match`、那一趟通知整个丢掉 | 既有 |
| **B6** | `start` 帧绕过"步还没开就别发"的闸门 | 第一帧在线增量就带着**最终没人认的** attempt 出去 | 我（第一轮修得不完整） |
| **B7** | `pendingKind ??=`（只赋值一次） | **思考→正文永远不换块**：正文被追加进思考那一块 | 我（被新探针抓住） |
| **B8** | 中途加入：`journal.step` 停在 0 | 页面开得晚时，在线行带着 `1:0` 出生 → 结算判定不上 → **同一条回答画两遍** | 既有 |
| **B9** | `pushStartFrame` 先置 `started` 再投递 | `start` 帧推失败后**永久补不回来** → 所有在线增量被客户端忽略 | 我 |
| **B10** | 快照基线包含"还没发过 `start` 帧"的 attempt | 客户端判 `rebaseline`、**整条流重建**、在线行丢掉 | 我 |

**未决 1 条**：B11 —— 中途加入的页面，在线文字**开头一段**不渲染（号、顺序、闸门都已正确；
见 §4）。

另外发现**两个产品侧问题**（不属于渲染链，但会让排查本身骗人）：§5。

---

## 二、排查方法：把"看不见的链路"变成能读的数据

这一类故障最贵的地方是**它不报错**。垫片里"推了但界面不画"有五种可能，现象一模一样：

1. 守护进程根本没推
2. 推了，垫片没收到
3. 垫片收到了，没有投递者（没有流在听）
4. 投递了，但**顺序不对**（客户端按协议拒绝）
5. 投递了、顺序也对，客户端不认（节点/闸门）

所以整轮排查是在**不断把不可见的环节变成可读数据**，最后靠这一条日志定位：

```
event step/start@1:1
event assistant/message@1:1
event tool/call@1:1
event tool/result@1:2      ← 属于第 1 步的工具返回，被标成第 2 步
event step/end@1:2         ← 第 1 步的结束，也标成第 2 步
event step/start@1:2
```

（`__REPLICA_DELIVER__`：**每条跟随流上按顺序投递了什么**，每行带该事件**自己携带的**
`turn:step` —— 客户端就是拿它算对话节点 id 的。在线帧和落盘事件是两条产线，只有合在
一条线上才看得出先后。）

新增/补强的诊断口与绊线见 §6。

---

## 三、逐个缺陷

### 3.1 守护进程这一段是好的（先排除掉）

用 Node 直接连 WS（不经过浏览器，`ws-check.mjs`），一轮收到：

```
event / turn_started 1 · step_started 1 · model_text_delta 39
event / assistant_message 1 · step_finished 1 · turn_finished 1
```

**39 条逐 token 增量一条不少**。所以问题不在"推没推"，而在垫片/页面这一侧。

---

### B1 ★ `step/start` 迟到 —— 这就是用户报的那个"完全不流式"

**根因。** 客户端的助手节点是**由 durable 的 `step/start` 创建**的：

```
dsh-client-ui-chat / trajectory  的 assistantDefinition
  match('step/start')            → role:'start'    ← 节点在这里被创建
  match('assistant/live-chunk')  → role:'update'   ← 只更新**已存在**的节点
```

而垫片里 `step/start` 唯一的发射点是"折到助手消息"那一步（`emitMessage` 的
assistant 分支调 `nextStep`）—— 也就是**这一步已经结束的时候**。于是模型还在吐字时
送到的那几十条在线增量，全落在一个**还不存在的节点**上：不报错、不抛异常，就是什么都不画。

**证据（修前）。**

| 判据 | 实测 |
|---|---|
| 一轮里的在线帧 | 42 条**都投出去了**（revision 连续、丢帧 0、投递者 1） |
| 页面长度 | 整整一轮冻结在 195，**一个字不长** |
| `step/start` 到达时刻 | 与 `assistant/message` / `step/end` / `turn/end` **同一批** |
| 垫片绊线 | 响了：`结算编号对不上` |

**修复。** 守护进程报 `step_started` 时就登记（`journal.stepPending`），由
[`openAnnouncedStep`](../tools/replica-shim.js#L2134) 把 `step/start` **提前**发出去。
位置是刻意的：排在**折消息之后**——`user/message` 必须仍在它前面（这正是原作者当初把
发射点推到末尾的理由，理由本身没错，代价却是一整类静默故障）。

**验证。** 修后：文字随增量递增（`页面长度` 325→335，而 `assistant_message` 还没到）；
事件序列变成干净的 `turn/start → user/message → step/start → assistant/message → step/end
→ turn/end`；控制台只剩一条与本问题无关的未实现 RPC 警告。

---

### B2 ★ 用户消息把权威步号抹成 0 → 同一条回答画两遍

**根因。** 折"用户消息"那一段里有一句无条件 `journal.step = 0`（本意是"新回合步数从头数"）。
而实时那条路上，`step_started` **可能已经把权威步号（1）抄进来了** —— 折消息是异步的，
要等一次 `/projection` 往返。于是那个 1 被抹成 0，助手消息带着 `step: 0` 出去，而在线
attempt 带的是 1 ⇒ 客户端的 `attemptForSettlement` 要求两者**逐字相等**，判定不上就把
同一条回答**再画一遍**。

**修复。** 步数复位只对**回放**成立：`if (!journal.stepLive) journal.step = 0`。
新回合该复位的那次，守护进程的 `turn_started` 已经复位过了。

**验证。** 绊线 `结算编号对不上` 不再响；多步回合上工具结果也回到自己那一步（见 B5）。

---

### B3 ★ `sealJournal` 无条件收步 → 流出来的字又被撤掉

**根因。** `sealJournal` 里有一句**无条件** `closeStep`。它写在"step 只在折到助手消息时
才开"的前提下（开和关在同一次 push 里），所以"无条件关"看起来等于"关掉刚折进来的那一步"。
而 B1 修好之后，活着的 step 会**跨很多次 push** 存在 —— 每一次 push 都调它 ⇒ 那一步
**刚开出来就被关掉**。

**证据。** 修到一半时的实测：文字先正常流出来（页面长度 330），收尾时**又整段被撤掉**
（→249，`含收到` 从 true 翻回 false），控制台报
`conversation Context … received non-appended Match 3`。

**修复。** 只在**回合真的停了**时才收尾：`if (status !== 'running') endTurn(journal)`。
中途的 `step/end` 交给 `nextStep`（下一步开始时）—— 那也正是"工具返回属于当前这个 step"
所要求的位置。

---

### B4 ★ 在线尾巴晚于落盘的 `assistant/message`

**根因（协议级的顺序约束）。** 客户端给在线帧算的合成 seq 是
`durableCursor + 1 − 1/(n+1)`，而 `durableCursor` 在**收到**落盘条目的那一刻就前进
（哪怕那条消息还在等 `end` 帧结算）。于是"先投落盘消息、再冲在线尾巴"的顺序下，
尾巴的 seq 变成 `3.5` ✓，紧接着落盘那条 `seq=3` 来装配时反而被判成**不递增** ⇒
订阅者抛错 ⇒ **那一趟通知整个断掉**，界面上的文字被撤掉。

**修复。** 顺序钉死为 **tail → assistant/message → end 帧**：新增
[`flushLiveTail`](../tools/replica-shim.js#L3661)，在投递落盘消息**之前**调用；
`closeBlock` 加幂等守卫（否则一个块会被收两次）。

---

### B5 ★ `tool/result` / `step/end` 挂错步号（既有缺陷，非本次引入）

**根因。** `closeStep`、`assistant/message`、`tool/call`、`tool/result` 都用
`journal.step` —— 而它的语义是"守护进程**最新宣布**的步号"。折消息是异步的，
`step_started(2)` 早就到了，于是**第 1 步的收尾被盖上第 2 步的号**。

后果有两个，第二个才是用户看得见的：

1. 客户端的 trajectory 定义里 **`step/end` 是一条 update** ⇒ 它先收到 `step/end@1:2`
   （1:2 的节点还不存在 → 建出一个"只有 update"的 context），紧接着 `step/start@1:2`
   才到 ⇒ 装配器抛 `received an update before its start Match`，那一趟通知被
   `notifySubscribers` 吞成一行日志。
2. trajectory 面板里，第 1 步的**工具返回和 step 结束挂在第二步下面**。

**这是既有缺陷，不是我的改动引入的** —— 用对照实验证明过：把 B1 的"提前开步"关掉
（退回原行为），同一个 context 一样报错。

**修复。** 新增 [`currentStep`](../tools/replica-shim.js#L2052) = **正在进行的那个 step**
（`openStep`，没开着时才退回 `journal.step`），四处 emit 全改用它；`closeStep` 报的是
它正在收的那一步。

---

### B6 `start` 帧绕过闸门（我第一轮修得不完整）

**根因。** `start` 帧原来在**建 attempt 那一刻**立刻推，而"步还没开就别发"那道闸在它
**之后**才判 ⇒ 第一次增量一到，`start` 帧就先跑了，那时 `step/start` 还没投递。
垫片的绊线抓到的就是它：`在线帧跑在 step/start 前面：{"step":"1:1","frame":"start"}`。

**修复。** 新增 [`pushStartFrame`](../tools/replica-shim.js#L3781)（只发一次、永远排在
块和增量之前），正常路径在 `ensureBlock` 之前调，被闸拦下的路径由
`flushDeferredDelta` 在 `step/start` 投递之后补调。

**附带一条不变量**（写进 `emitChunk`）：**`start` 帧没投递成功之前，一个 chunk 都不发**。

---

### B7 `pendingKind ??=` → 思考→正文永远不换块（我引入的）

**根因。** 给闸加"攒着的那段属于哪一类"时写成了 `??=`（只赋值一次、永不变更），
于是 `ensureBlock` 永远收到**这个 attempt 第一条增量**的类型 ⇒ 换块再也不会发生：
正文被追加进思考那个块里（或反过来）。界面上看起来"有字"，只是**分类错了** ——
这一类最容易静默逃过验收。

**修复。** 两个概念分开：`pendingKind` = "攒着的那段"（从空开始攒时定）；
`ensureBlock` 用**当前这条增量**的类型（`kindType`）。

**这一条是被新探针抓住的**：`scripts/fake-server.ts` 从不吐 `reasoning_content`，
所以"思考→正文换块"在这个仓库里**从来没被验过**。补了
`.repro/fake-reasoning-server.mjs` 之后，第一次跑就抓住了它。

---

### B8 ★ 中途加入：`journal.step` 停在 0（用户批准修的那一格）

**场景。** 界面**在回合已经跑起来之后**才打开（刷新、切回来、刚打开）时，守护进程
早把 `turn_started` / `step_started` 广播过去了 —— **那条连接没见过**。于是
`journal.step` 停在 0、闸门也不拦（它只认 `stepPending`），增量带着 `1:0` 出生，
而落盘消息是 `1:1` ⇒ 结算判定不上 ⇒ 同一条回答画两遍。

**证据（修前，中途加入探针）。**

```
在线帧的turnStep: ["chunk/0:0", "end/0:0"]      ← 号是 0:0
开步记录: ["open@1:1"]                          ← 步是后来才开的
绊线: 结算编号对不上 {在线attempt:{0,0}, 落盘消息:{1,1}}
```

**修复（两处）。**

1. [`ensureJournal`](../tools/replica-shim.js#L3083)：会话**在跑**、这条连接又**没见过**
   本回合的边界事件时，把**投影里的 `turn`/`step` 当权威边界**（`Session.projection()`
   直接回 `#turn`/`#step`，而 `#step += 1` 发生在 `step_started` **之前** ⇒ 运行中的
   投影里就是当前位置），并置 `stepPending` ⇒ 这一步照常被 `openAnnouncedStep` 开出来。
   三个条件缺一不可：`status === 'running'`、`stepLive !== true`、投影里**已有用户消息**
   （否则折消息那一步会 `turn += 1`，把回合号顶成下一个）。
2. [`pushStartFrame`](../tools/replica-shim.js#L3781)：步号在**发 `start` 帧的那一刻**
   重新取一次，而不是沿用建 attempt 时定的那个。（`startedAfterSeq` 不动 —— 取更小的
   值只会更安全。）

**验证（修后）。** `在线帧的turnStep = ["start/1:1", "chunk/1:1", "end/1:1"]` ✓、
`开步记录 = ["open@1:1"]` ✓、**两条绊线都不响** ✓、可达回合结束且正文在 ✓。

---

### B9 `pushStartFrame` 先置 `started` 再投递（我引入的）

**根因。** 第一版是"先 `attempt.started = true`，再 `pushLiveFrame`"。而
`pushLiveFrame` 在没有投递者时返回 false（那一刻还没有跟随流）⇒ **`start` 帧被永久吞掉**，
之后哪怕流已经建好、`flushDeferredDelta` 再来调，也会在第一行直接 return ⇒ 客户端
永远没认下这个 attempt ⇒ 所有在线增量被它忽略。

**修复。** 和 `emitChunk` 同一条纪律：**投递成功才记账**（`if (delivered !== true)
attempt.started = false`）。

---

### B10 快照基线包含"还没发过 `start` 帧"的 attempt（我引入的，中途加入那条路的最后一坑）

**根因。** 客户端的 `acceptFrame('start')` 第一件事是：

```js
if (this.activeAttempt !== void 0 || this.retainedAttempt !== void 0 || this.pending.size > 0)
  return { type: 'rebaseline' }     // ← 不是"忽略"，是**要求重建整条流**
```

而基线（`assistantStream.activeAttempt`）的作用是"让新开的流接上一个**已经在流**的
attempt"。把"连 `start` 帧都还没发出去"的 attempt 塞进基线 = 先让客户端认下它，
紧接着那一帧 `start` 到了 ⇒ **rebaseline**、整条会话流重建、在线行丢掉。

**修复。** [`liveStreamBaseline`](../tools/replica-shim.js#L3436) 里
`if (attempt === undefined || attempt.started !== true) return { revision }` —— 这种
attempt **不给基线**，让随后的 `start` 帧顺理成章被接受。

**证据。** 修前中途加入的探针里 `快照次数 = 2`（= 重建过一次），且在线行始终没有正文；
修后快照仍是 2（客户端本来就会重开一次流），但帧的顺序变成
`snapshot → step/start → start → block-start → text-delta` ✓。

---

## 四、未决：B11 —— 中途加入的页面，在线文字**开头一段**不渲染

**现状（诚实记录）**：中途加入的页面里，"正在跑"的指示牌出来了、帧也按**正确的步号**
（`1:1`）到了、两条绊线都不响、`start` 帧也在（`["start/1:1","chunk/1:1"]`），但
**在线行的文字只看得见后面一小段**，开头那段没有（`含收到: false`，而正文里第一个词就是
"收到"）。收尾后的**落盘正文完整显示**（实测 `收尾后正文在: true`）。

**已排除**：不是号错（B8 已修）、不是顺序（绊线不响）、不是状态闸门（能看到"深度求索中"）、
不是守护进程（§3.1）。

**下一步该查哪里**：客户端 `ClientAssistantStream` 的接受判定
（`acceptFrame('chunk')` 的 `index === nextIndex`、以及 `rebaseline` 的次数）。
需要给那三个插件加一个**只读诊断口**（把 `rebaseline`/忽略的判定结果计数暴露到 `globalThis`），
这一步会动到 DSH 的产物文件，所以先没做。

**影响面**：只在"页面开得比回合晚"时出现；文字最终会由落盘消息补全，所以是**观感**问题，
不是数据丢失。

---

## 五、顺带发现的两个产品侧问题（不属于渲染链）

1. **`MVS_HOME` 盖不住恢复层。** `src/recovery/index.ts:25` 用的是 `os.homedir()`
   而不是 `defaultHomeDir()`，所以只设 `MVS_HOME` 时，恢复快照仍然往真实的
   `~/.mvs-agent/recovery` 写 —— 任何"重定向状态根目录"的运行（测试、便携部署）
   里，**工具调用会以 `EPERM` 失败**，看起来像"工具坏了"。
   复现时必须**同时**设 `MVS_RECOVERY_DIR`（`.repro/README.md` 里记了这条）。
2. **假端点不吐思考。** `scripts/fake-server.ts` 从不发 `reasoning_content`，
   于是"思考→正文换块"这条路在本仓库**零覆盖** —— B7 就是这么溜进来的。

---

## 六、为这次排查留下的诊断口与绊线

打开页面后从控制台读（探针也可以直接取）：

| 全局量 | 内容 |
|---|---|
| `__REPLICA_DELIVER__` | **这条流按顺序投递了什么**；事件行带它**自己携带的** `@turn:step` |
| `__REPLICA_STEP_OPEN__` | `openAnnouncedStep` 每次的结果（`open@1:1` / `skip:not-running@…` / `already-open@…`） |
| `__REPLICA_LIVE__` | 每条在线帧：类型、revision、`turnStep`、chunk 类型、块类型 |
| `__REPLICA_WS_COUNT__` | WS 上每种帧各来了多少（**累加**，不受采样上限影响） |
| `__REPLICA_ACCEPT__` | 垫片收下多少增量、当时有几个投递者 |

**两条绊线**（把静默故障变成一行日志）：

- `[replica] 在线帧跑在 step/start 前面 …` —— 客户端会抛 `update before its start Match`
  并把那一趟通知整个丢掉（`tools/replica-shim.js:4703`）
- `[replica] 结算编号对不上 —— 这条回答会被渲染两遍 …`（`tools/replica-shim.js:2320`）

---

## 七、验收（五条，全部可复跑）

| # | 探针 | 判据 | 结果 |
|---|---|---|---|
| 1 | `probe-verify.js` | 回合结束前就有字 + 收尾后还在 + 事件序列干净 | ✓ |
| 2 | `probe-tool.js` | 两个 step、`tool/result` 落在**自己那一步**、最终答复 | ✓ |
| 3 | `probe-two-turns.js` | 跨回合编号 `@1:2 → @2:1`，不串台 | ✓ |
| 4 | `probe-reasoning.js` | 两个块（`reasoning#0 → text#12`）、两类 delta 各落各的 | ✓ |
| 5 | `probe-join.js` | 中途加入：号 = `1:1`、绊线不响、状态闸门开 | ✓（文字开头段：见 B11） |

复跑方式见 `.repro/README.md`（含两个必须知道的坑：探针采样不能用 `sleep()` 驱动；
`MVS_HOME` 必须配 `MVS_RECOVERY_DIR`）。

---

## 八、这份报告自己的边界

- 所有"修后"结论都来自**实测**（无头 Edge + 假模型端点 + 守护进程），不是读代码推的。
- 所有"守护进程是好的"结论来自**直接连 WS**（`ws-check.mjs`），不经过浏览器。
- B5 是既有缺陷，用**对照实验**（把 B1 的修复临时关掉）证明过，不是推测。
- B11 只有"现象 + 已排除项"，**没有定论** —— 不想把推测写成结论。
- 用户的真实 `~/.mvs-agent` 未被这次排查写入（核对过：那段时间里的写入是用户自己的
  另一个工作区会话）。所有复现都跑在重定向的 `MVS_HOME` 里。
