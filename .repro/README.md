# `.repro/` —— 排查「流式输出不渲染」时用的复现件

这一目录只服务于**那一次排查**，不是产品的一部分。可以整个删掉。

## 怎么跑

```bash
# 1) 假模型端点（不花钱、逐字流式）
node scripts/fake-server.ts                       # :8787

# 2) 守护进程，状态落在工作区内的假 home（不碰你真实的 ~/.mvs-agent）
$env:MVS_HOME          = "<本目录>/home"
$env:MVS_RECOVERY_DIR  = "<本目录>/home/recovery"   # ⚠️ 见下面「已知问题」
$env:MVS_BASE_URL      = "http://127.0.0.1:8787/v1"
$env:MVS_MODEL         = "fake"
node tools/serve-bg.mjs 3092 "<工作区绝对路径>"

# 3) 探针
node tools/probe-eval.mjs http://127.0.0.1:3092/ --expr-file .repro/probe-verify.js \
  --wait '[class*="sessionRow"]' --budget 120000
```

## 各个文件是什么

| 文件 | 看什么 |
|---|---|
| `probe-verify.js` | **主验收**：文字在回合结束前就长出来（真流式）＋ 收尾后还在 ＋ 事件序列干净 |
| `probe-tool.js` | 多步回合（工具调用 → 第二次模型调用）：两个 step、`tool/result` 归属、最终答复 |
| `probe-two-turns.js` | 同一会话**连发两轮**：跨回合编号（`@2:1`）有没有串台 |
| `probe-reasoning.js` | **思考 → 正文换块**（要配 `fake-reasoning-server.mjs`）：两个块、两类 delta 各落各的 |
| `probe-join.js` | **中途加入**：回合已经在跑之后才打开页面 —— 号必须仍是 `1:1`、两条绊线都不许响 |
| `probe-health.js` | 点了会话行之后，跟随流/订阅 socket/控制台健不健康（排查"页面本身是不是坏的"） |
| `fake-reasoning-server.mjs` | 假端点，**会吐 `reasoning_content`** —— `scripts/fake-server.ts` 从不吐，所以那条路它验不到 |
| `ws-check.mjs` | **不经过浏览器**，直接问守护进程：这一轮到底推了哪些帧（用来把"服务端不推"和"页面不画"分开） |
| `probe-streams.js` | 同一会话同时开着几条跟随流（帧是**一次性发给所有流**的，这是顺序类故障的前提） |
| `probe-order.js` | 在线增量与 durable 边界事件（`step/start` 等）的先后 |
| `probe-live2.js` | 只抓五个断点的计数（WS 收到 / 垫片收下 / 在线帧 / 跟随流 / 页面文字） |
| `probe-stack.js` | 把客户端订阅者抛错的**调用栈**带回来 |
| `probe-live.js` | 第一版，被虚拟时钟骗过（采样循环被快进），留作对照 |

## 垫片里为这次排查留下的诊断口

打开页面后从控制台读（探针也可以直接取）：

| 全局量 | 内容 |
|---|---|
| `__REPLICA_DELIVER__` | **这条流按顺序投递了什么** —— 在线帧和落盘事件**合在一条线上**，`@turn:step` 是事件自己携带的号 |
| `__REPLICA_STEP_OPEN__` | `openAnnouncedStep` 每次的结果（`open@1:1` / `skip:not-running@…` / `already-open@…`） |
| `__REPLICA_LIVE__` | 每条在线帧：类型、revision、`turnStep`、chunk 类型、块类型 |
| `__REPLICA_WS_COUNT__` | WS 上每种帧各来了多少（累加，不受采样上限影响） |
| `__REPLICA_ACCEPT__` | 垫片收下多少增量、当时有几个投递者 |

还有一条**绊线**：在线帧若跑在它那一步的 `step/start` 前面，会当场打一行
`[replica] 在线帧跑在 step/start 前面 …`（这类故障在界面上只表现为"字莫名没了"）。

## ⚠️ 两个坑（都会让复现结果骗人）

1. **探针的采样循环不能用 `sleep()` 驱动。** 探针跑在 `--virtual-time-budget` 下，
   虚拟时钟在没有未完成网络请求时会一口气快进 —— 循环几毫秒就跑完，而守护进程
   那时还没开始推增量。每次迭代都要 `await fetch('/state')`（见 `probe-live2.js` 顶部）。

2. **`MVS_HOME` 盖不住恢复层。** `src/recovery/index.ts:25` 直接用了 `os.homedir()`
   而不是 `defaultHomeDir()`，所以只设 `MVS_HOME` 时，恢复快照仍然往真实的
   `~/.mvs-agent/recovery` 写 —— 工具调用会因此以 `EPERM` 失败，看起来像"工具坏了"。
   复现时必须**同时**设 `MVS_RECOVERY_DIR`。

3. **"思考看不见"不一定是丢了。** 界面把思考画成**可折叠**的块，折叠时它的字
   不在 `innerText` 里 —— 判据要用 `innerHTML`（或落盘消息的 `contentBlocks`），
   否则会把"折叠"误判成"没渲染"。

4. **探针的观察窗口要短，而且样本要省。** 页面变重之后（几十个会话 + 长会话），
   `innerText` 会强制排版、每轮都读会把 `--virtual-time-budget` 耗光 —— 结果是
   Edge 在表达式返回**之前**就把 DOM dump 走，探针**一句话都不输出**（看起来像
   "页面没加载"）。规矩：只在计数变化时读 DOM、循环上限几百轮、把判据压到"加入后
   几秒内可得"。

5. **会话一多，旧探针会假绿/假红。** 探针点的是"侧栏第一行"，如果那一行是个正好
   在跑慢回合的会话，新消息会被拒，现象是"设上去了但一直不结束"。**回归测试用干净的
   `MVS_HOME`**（本目录的 `home*` 都是这么用的，跑完就删）。

## 完整结论

逐个 BUG 的症状、根因、证据、修复位置：见 `docs/流式输出渲染-BUG报告.md`。
