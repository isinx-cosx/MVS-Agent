# 设计笔记：沙箱、权限与可逆性

本文汇总三条线的结论：**我们自己的实测**、**对现有产品的调研**、**本机 DSH 实现的可读源码**。

标注约定：**[实测]** = 我们在本机验证过；**[一手文档]** = 厂商官方文档原文；**[源码]** = 直接读过实现；**[未验证]** = 明确未确认。

---

## 零、结论先行

**在 Windows 桌面上，对终端用户而言，「预防」做不到完整，而「恢复」可以。**

因此三层必须分开，而且必须在**不同的层次**上实现：

| 层 | 机制 | 实现层次 | 免提权 | 覆盖 | 强度 |
|---|---|---|---|---|---|
| **预防** | `WRITE_RESTRICTED` 受限令牌 + 能力 SID | 操作系统（令牌） | ✅ | 仅写 | 部分（partial） |
| **恢复** | 执行前后整目录基线快照 | **工具分发之下** | ✅ | 文件系统全部变更（含 shell） | 完整（有界） |
| **审计** | append-only 事件日志 | 应用层 | ✅ | 记录快照边界 | 记录，不拦截 |

三个**不可混淆**的要点：

1. **预防和恢复必须在不同层次。** 预防在 OS 层，恢复在工具分发之下。
2. **恢复绝不能在工具层。** 工具层恢复从结构上漏掉 shell 通道（见第三节）。
3. **事件日志记录的是「快照边界」，不是「我改了哪些文件」。** 这两者不等价，而正是这个不等价造成了 Claude Code 与华为 CodeArts 的同一个洞。

---

## 一、为什么 Windows 上没有「完整的预防」

### 实测否定的路线

| 路线 | 结果 |
|---|---|
| **AppContainer** | 隔离效果全对（挡读用户目录 / 挡写 / 断网，免提权），但**执行工具链确定性失败**：`node -v` 五次全拒，而读同一个文件成功 [实测] |
| **受限令牌（我最初的错误尝试）** | `CreateProcessAsUser` 免提权成功，但子进程立刻以 `0xC0000022` 死亡 [实测] |

AppContainer 的失败原因被独立确认：**「AppContainer 根本无法任意路径读取」** [源码，`dsh-sandbox-windows-acl` README]。OpenAI 走过同一条路——Codex 的 Windows 沙箱博客路线是「AppContainer → write-restricted Token → Windows Firewall」，另有一个 issue 记录 AppContainer/lowbox 挡住了 `\GLOBAL??` 路径解析。

### 第二条失败是**测试设计错误**，不是机制失败

我用的 restricting SID 列表是 `[BUILTIN\Users]`。正确列表 [源码]：

| 模式 | restricting SID 列表 |
|---|---|
| `read-only` | `[登录会话 SID, Everyone]` |
| `workspace-write` | `[登录会话 SID, Everyone, 工作区 SID, 临时目录 SID]` |

文档明确写着：**没有登录 SID 和 Everyone，早期 DLL 初始化会以 `0xC0000142` 死亡。** 另外还必须调用 `setTokenDefaultDaclGrant`，把一个 restricting SID 的 ACE 合并进令牌的**默认 DACL**，否则令牌新建的对象（如匿名管道）在创建时就通不过写检查。

**教训：不要用一个失败样本宣布一条技术路线死亡。** 这次的失败样本里有两个我自己的 bug。

### 可行方案的机制与边界

**机制一句话** [源码]：把调用者令牌复制为 `WRITE_RESTRICTED` 受限令牌，其 restricting SID 携带彼此独立的能力——一个由**工作区规范路径确定性派生**的工作区 SID（`S-1-4-x-y`），加一个每会话私有的临时目录 SID。Windows 只在「调用者正常权限」与「restricting SID 交集」**同时**允许时才放行**写入**。

**关键优势**：`WRITE_RESTRICTED` **只交叉检查写**，读是正常的——所以进程能加载 DLL、能执行工具链。这正是 AppContainer 做不到的。

**免提权的原因** [源码]：所有者隐含的 `WRITE_DAC` 就是你能改 DACL 的原因。

**必须如实报告的边界**（这份实现自报 `enforcement: 'partial'`）：

| 边界 | 后果 |
|---|---|
| **Everyone 的环境授权仍是写来源** | 外部 NTFS 对象若给 Everyone 写权限，两次检查都过 |
| **硬链接是文件对象别名** | 可继承的工作区 ACE 传播到已有硬链接会改同一文件的描述符，可从外部别名写入。pnpm 就用硬链接，无法一律拒绝多链接文件 |
| **只限写，不限读 / 网络 / 进程可见性** | 凭据仍可读，外泄仍可能 |
| 控制台隔离不可用 | `CREATE_NO_WINDOW` 会让子进程以 `STATUS_DLL_INIT_FAILED` 死亡 |
| **受限孙进程无法用管道捕获输出** | 命名管道默认 SD 模板不给 restricting SID 写权限 → Node 报 `spawn EPERM`。**inherit（fd）与 ignore stdio 可用** |
| `whoami` / 令牌检查 cmdlet 失败 | 诊断噪音，非运行故障 |
| 授权是全树**急切**传播 | 大工作区首次授权要几十秒，每机器每工作区一次 |
| read-only 下 PowerShell 进 ConstrainedLanguage | `Add-Type`、非核心 .NET、COM、反射全失败 |

> ⚠️ **`spawn EPERM` 解释了本会话遇到的第一个错误**：`node --test` 因管道 stdio 挂掉。当时我绕过去了（改用 fd 重定向），现在知道了根因。

---

## 二、权限模型：该抄的与该避的

### 现有产品的默认姿态 [一手文档]

| 产品 | 默认 | 白名单粒度 | 逃生门 |
|---|---|---|---|
| Cursor IDE | 命令需批准；**文件编辑不需** | 命令字符串**前缀**匹配；**schema 里没有 denylist** | Auto-review / Allowlist / Run Everything |
| Cursor CLI | 独立系统 | `Shell(ls)` 式 token，**有真 deny**，deny 优先 | `--force` |
| Cline | 全部询问直到逐项开启 | **没有白名单**，模型自己标 `requires_approval` | YOLO |
| **Roo Code** | 逐项开关，默认关 | **真前缀白名单 + denylist**，**最长前缀胜** | `*` |
| Claude Code | **`auto`**（v2.1.283+） | 整条命令文本上做 glob | 六种模式 |
| Aider | **没有任何权限模型** | 无 | `--yes-always`；安全靠 git auto-commit + `/undo` |

### 该抄的六个机制

1. **不可绕过的熔断器（Claude Code）**——保护路径（`.git`、`.bashrc`、`.npmrc`、`.mcp.json`…）与关键路径删除（文件系统根、家目录、工作目录及其父级）**永远不被 allow 规则预先批准**，检查在 allow 求值**之前**。文档明说动机是「**这个熔断器防的是模型出错**」——与「防手滑」定位一致。
2. **重复拦截阈值（Claude Code）**——连续 3 次或累计 20 次被拦，auto 模式**自动暂停**并恢复逐次询问，不可配置。这是最明确的**抗疲劳熔断**。
3. **deny 优先 + 最长前缀胜（Roo Code）**——Cursor IDE 的 schema 缺 denylist 是已知痛点（论坛用户反复找不到）。
4. **危险替换守卫（Roo Code）**——命中危险参数/进程替换（`${var@P}`、子 shell、here-string、zsh `=(...)`）即使前缀在白名单内也不自动放行。
5. **读放行、写拦截**（Cline / Roo / CC 三家一致）。
6. **确定性 hook 接缝**（Cursor / CC）——必须成立的规则不要走提示词。

### 该避的三个坑

1. **fail-open 默认值。** Cursor 的 hooks `failClosed` **默认 false**（崩溃/超时/非 2 退出码一律放行）；Cline SDK 未列出的工具**默认启用且自动批准**。**上游 POC 是同一个病**：`CreateRestrictedToken` 失败就静默用完整无限制令牌跑子进程 [源码]。**「看起来在沙箱、实际完全没沙箱」比没有沙箱危险得多。**
2. **静默忽略规则。** Claude Code 有几类规则形状是**接受了但从不生效**的（`Bash(command:rm *)`、`Write(path)`），只给一条启动警告。
3. **字符串匹配白名单。** 三个 Cursor CVE 全是同一类：[CVE-2025-54131](https://app.opencve.io/cve/CVE-2025-54131)（`$(cmd)` 绕过）、[CVE-2026-22708](https://app.opencve.io/cve/CVE-2026-22708)（shell 内建 + 环境变量投毒）、[CVE-2026-31854](https://app.opencve.io/cve/CVE-2026-31854)（网页注入，8.7 High）。

### 确认疲劳有厂商自己的数字 [一手文档]

Cursor 公告原文：**「经过足够多次重复提示后，人就不再仔细读了，审批流程也就失去了意义。」**
分类器只拦 **~4%** 的动作；只有 **~7%** 的会话出现 ≥1 次打断；某些企业客户**之前 ~40% 的动作被拦**。

### 我们的结构性优势与一个待补的洞

**优势**：我们的 `run_command` 签名是 `{command, args: string[]}`，**默认不经 shell**。没有 shell 解析、没有替换、没有引号歧义——**三个 CVE 的整个漏洞类别在我们的工具签名上从结构上不存在。**

**洞**：但**不给 `args` 时会走 shell**，那就是同一个入口。**要么把 shell 模式拆成需要显式确认的独立工具，要么去掉。**

---

## 三、恢复：唯一跨平台成立的承诺

### 「bash 删的东西撤不回来」是架构缺陷，厂商文档写明 [一手文档]

| 产品 | 原文 |
|---|---|
| Claude Code | 章节标题即 **「Bash command changes not tracked」**；`rm`/`mv`/`cp`、`echo >`、`sed -i` 全不覆盖 |
| 华为 CodeArts | 「通过 Bash 命令或外部编辑器做的文件修改不会被追踪」 |
| Kiro | 「不追踪 MCP 工具或 bash 命令做的文件修改」 |

Claude Code 另有四个缺口：子代理编辑不恢复（后台子代理只能「用 git 回退」）；外部修改不追踪；**符号链接与硬链接路径直接跳过**（pnpm 硬链接被点名）；快照约 30 天过期、每会话只留最近 100 个。

**甚至有 UI 会撒谎**：[issue #34368](https://github.com/anthropics/claude-code/issues/34368) —— rewind 提供「撤销文件删除」选项，点了什么也不做。

### 核心结论

> **从工具级 checkpoint 内部，无法覆盖 shell 通道。**

所有能覆盖 shell 的方案，都是把**快照边界挪到 agent 之下**：

| 架构 | 覆盖 | Windows |
|---|---|---|
| hook + 真实 bash 解析器（`doover`，152 条规则） | 静态可解析的命令 | **❌ 明确不支持原生 Windows** |
| 文件监听 + 整树快照（`stepback` / `safesandbox`） | ✅ 天然覆盖 | ✅ 纯文件复制 |
| **执行前后整目录基线快照（`nono --rollback`）** | ✅ 包围整个执行 | ✅ |
| 卷级快照（`unlose`，Windows VSS） | ✅ 不可绕过 | ⚠️ **需要管理员** |

**CoW 在 Windows 上基本不存在**：`doover` 明确写「原生 Windows 不支持」，EvoX 支持表写「**Windows: ❌ 回落到完整复制**」。唯一在 Windows 做卷级的 `unlose` **需要管理员**——正是我们证明不可行的前提。

> **最强的可逆性保障，恰恰在最需要它的平台上最不可用。**

### 选型建议

**用「执行前后整目录基线快照」，不要用工具级 checkpoint，也不要依赖 CoW。**

理由：跨平台一致（纯文件复制）、零提权、天然覆盖 shell、实现简单。代价是复制成本，用排除规则控制（`node_modules`、构建产物、缓存）。

### 四种必须显式设计的失败模式

1. **无法解析的命令。** `doover` 的立场值得抄：**按危险处理**，快照 CWD，并**记录覆盖是尽力而为的**。绝不假设安全。生产环境要度量这一档的占比。
2. **被忽略的文件。** 尊重 `.gitignore` 的快照工具会漏掉 `.env`、本地数据库、测试数据。**这是策略选择，必须对用户显式。**
3. **恢复本身毁数据。** [copilot-cli#1675](https://github.com/github/copilot-cli/issues/1675)：`rollbackToSnapshot()` 执行 `git checkout --force` + `reset --hard` + **`git clean -fd`**，永久删除约 1GB agent 只「读过」的未跟踪产物。**恢复操作本身是一条 shell 命令，而没有任何东西在给 shell 做快照。** Kiro 记录了同类：快照后你手动改了文件，回滚时你的改动没了。
   → **回滚必须自己被记录、且自己可回滚。** 缓解：冲突检查（文件在动作之后被改过就**拒绝**并退出码 3，要 `--force`）；恢复前先做一次快照。
4. **快照库在爆炸半径内。** 同盘、有上限、会被 agent 摧毁。**「损害可以撤销」会退化成「损害可以撤销，除非撤销数据也被打掉了」。**

### 两个直接抄的原则

- **拒绝是功能。** Aider 的 `/undo` 在五种情况下主动拒绝并说明原因（非本会话的提交、合并提交、文件有未提交改动、文件在上个提交不存在、已推送）。**这些拒绝防止 undo 吃掉无关的工作。**
- **规则只能加强，不能削弱。** `doover`：规则表可叠加**加强**分类，但**明确不能削弱**已发布的规则——有人写「`rm` 是安全的」→ 忽略并警告。

### 学术界的收敛方向 [论文摘要]

- **YoloFS**（[arXiv 2604.13536](https://arxiv.org/abs/2604.13536)）：文件系统三原语 **introspect / undo / gate**；核心是**把变更暂存到用户提交为止**，比 undo **严格更强**。
- **Planarian**（[arXiv 2609.35366](https://arxiv.org/abs/2609.35366)）：本地方案 + **为远程效应记录补偿动作**——唯一能同时覆盖 `rm -rf` 与 `DROP TABLE` 的已发表设计。
- **Cordon**（[arXiv 2606.17573](https://arxiv.org/abs/2606.17573)）：语义事务 + **外部效果放进 outbox 暂存**。

**收敛设计**：能看到的本地状态就快照，看不到的就记录显式的前向逆操作。

---

## 四、架构形态：三个独立实现收敛到同一个形状

DSH 的实现、Claude Code、Cursor 的 hook 都是同一个形状：

**一个 runner，作为 argv 前缀包装，挂在「本地」后端之下，并如实上报自己的执行强度。**

```
node runner.js --workspace <dir> --temp <dir> --mode <read-only|workspace-write> -- <argv...>
```

这是本项目一直缺的那块：**把执行后端做成可替换的接口**，每个实现如实自报能力。

```ts
interface ExecutionBackend {
  id: string
  probe(): Promise<BackendCapabilities>
  run(spec: CommandSpec, ctx: ToolContext): Promise<ToolResult>
}

interface BackendCapabilities {
  filesystemWrite: 'none' | 'workspace' | 'allowlist' | 'any'
  filesystemRead:  'workspace' | 'allowlist' | 'any'
  network:         'none' | 'restricted' | 'open'
  enforcement:     'full' | 'partial' | 'none'
  reason?: string   // 降级原因，必须能展示给用户
}
```

**产品铁律**：永远显示**这一刻实际生效的是什么**，而不是设计上想要什么。已有 `denied`（我们的策略拒绝）与 `sandbox`（系统拒绝）两个错误类型正好支撑这个区分。

---

## 五、仍未验证的事项

诚实标注，不要把推测当结论：

- **`WRITE_RESTRICTED` 路线我们从未成功跑过一次。** 上述结论全部来自 DSH 的源码与文档，我未复现。要落地必须先跑通最小验证。
- **真正的标准用户账户（不在管理员组）能否创建 AppContainer profile** —— 本机无法验证。
- **独立用户账户 + `CreateProcessWithLogonW` 路线** —— 需提权创建用户，本机无法验证。`nub-sandbox` 的 PR 标题是「dedicated-account + WFP backend」，说明有人在做，但我未读其实现。
- **Claude Code checkpoint 的存储内部结构** —— 文档只说「file snapshots」，从未提 git。**不要断言是纯文件复制还是影子 git。**
- **Qwen Code 的 Shell 工具是否触发 checkpoint** —— 文档含糊，未确认。
- **未找到基于 ZFS/btrfs 快照的 agent 回滚工具**，也未找到使用 APFS 本地快照（`tmutil`）的。CoW `clonefile` 是不同机制，不要混淆。
- **性能数字全部是作者/厂商自报**，无一独立复现。

---

## 六、本会话踩到的两个坑（复现要点）

- **`.ps1` 必须带 BOM 或纯 ASCII。** Windows PowerShell 5.1 把无 BOM 的 UTF-8 按 ANSI/GBK 解码，中文被解坏后破坏字符串边界并导致解析错误。
- **不要把清理调用包在静默的 `try/catch` 里。** 本次有 9 个 AppContainer profile 全部残留而没有任何提示。静默失败掩盖资源泄漏，是产品级问题。同理，安静地忽略配置规则比没有配置更危险。
