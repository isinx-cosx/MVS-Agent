# Windows 沙箱：现有产品的实际做法

本文是调研结果，用于回答一个问题：**在 Windows 上给终端用户做本地命令执行沙箱，别人做到哪一步了？**

标注：**[一手]** = 官方文档/源码；**[issue]** = GitHub issue 标题中的真实错误串；**[二手]** = 博客/译文；**[未验证]** = 明确未确认。

---

## 一、平台支持矩阵

| 产品 | Win | macOS | Linux | Windows 机制 | 需要管理员 |
|---|---|---|---|---|---|
| **Claude Code**（沙箱 bash 工具） | **❌ 不支持** | ✅ Seatbelt | ✅ bubblewrap | 未实现；Windows 需 WSL，而 WSL 在 Windows 原生沙箱之外 | n/a |
| **Anthropic `sandbox-runtime`**（OSS 后端） | **❌ 不支持** | ✅ | ✅ | 包被标记为仅 macOS + Linux | n/a |
| **Cursor**（agent 终端） | **❌ 不支持** | ✅ | ✅ | 直接报错：`sandboxing is not supported on Windows` / `unsupported_platform` | n/a |
| **GitHub Copilot CLI** | **❌ 不支持** | ✅ | ✅ | fail-closed：`Sandboxing is enabled but is not supported on this host` | n/a |
| **Gemini CLI** | ❌ | ✅ `sandbox-exec` | ✅ Docker/Podman | 容器方案，非 Windows 原生；存在「为 Windows 构建沙箱」的 PR | n/a |
| **Cline / Roo Code** | **❌ 无** | ❌ 无 | ❌ 无 | **全平台都没有 OS 运行时沙箱**，只有审批 UX（auto-approve / YOLO / ignore 文件） | n/a |
| **OpenHands** | ❌ | ❌ | ✅ Docker | Docker runtime；一个 Windows「本地 runtime」PR 只是加了 PowerShell 执行，**不是沙箱** | n/a |
| **Devin / Manus** | n/a | n/a | n/a | 云 VM。Manus 的本地「My Computer」模式驱动用户真实桌面，**没有隔离边界** | n/a |
| **OpenAI Codex** | **⚠️ 有** | ✅ Seatbelt | ✅ bwrap / Landlock | 专用沙箱账户 + `CreateProcessWithLogonW` / `CreateProcessAsUserW` + ACL + **Windows 防火墙**；独立 `codex-command-runner` 二进制 | **是**（一次性 UAC 安装期提权），有 `unelevated` 回退 |
| **DSH**（本机运行的 harness） | **✅ 有** | ✅ | ✅ | **`WRITE_RESTRICTED` 受限令牌** + 独立的工作区/私有临时合成 SID；POSIX 上用 bwrap/Landlock/Seatbelt | **否**——用调用者自己的令牌即可 |

> **关键结论：整个调研里，只有两个产品在 Windows 上真正实现了原生沙箱。** 其余要么明确不支持（Claude Code、Cursor、Copilot CLI），要么根本没有 OS 沙箱（Cline / Roo / OpenHands）。

---

## 二、Codex：唯一实现完整覆盖的方案，以及它的代价

### 它试过哪些路

OpenAI 的工程博客章节锚点本身就是设计史的证据 [二手，但锚点原文可读]：

- `#das-redesign-die-elevated-sandbox` ——「**重新设计：elevated sandbox**」
- `#netwerktoegang-beperken` ——「限制网络访问」
- 一篇第三方技术总结的标题即：**「从 AppContainer，到 write-restricted Token，再到 Windows Firewall」**

**结论：OpenAI 试过 AppContainer，失败了，然后做了分层设计。** 这与我们自己的实测以及 DSH 的文档三方一致。

DSH 的 README 给出了 AppContainer 失败的原因 [一手]：

> 「AppContainer **根本无法任意路径读取**」；mxc 需要 Windows 11 24H2 的 OS 下限，且任意路径读取需要**整体改写宿主 DACL**。

### 它最终的机制（从错误串反推）

这些是 Codex runner 抛出的真实错误，来自 issue 标题，比任何文档都具体：

| 错误串 | 说明什么 |
|---|---|
| `CreateProcessAsUserW failed: 5` | 提权路径用 `CreateProcessAsUserW` |
| `CreateProcessWithLogonW failed: 1326` / `1909` | 另一条路径用 `CreateProcessWithLogonW`——**即一个独立的 Windows 登录账户**（1326 = 登录失败，1909 = 账户被锁定） |
| `GetTokenInformation(...)` 派生 **sandbox logon SID** | 真的派生了登录会话 SID 并用于 ACL 授权 |
| 工作区被留在 **`CodexSandboxOnline`** 名下 | **具名沙箱账户** |
| `SetNamedSecurityInfoW failed: 87` / `error 5` | ACL 物化走 `SetNamedSecurityInfoW` |
| `os error 740` / `ERROR_ELEVATION_REQUIRED` | **安装期越过 UAC 边界** |
| `AppContainer blocks all outbound TCP` | 网络在 AppContainer 下是专门的问题 |
| `find_codex_home()'s canonicalize() needs \GLOBAL?? DOS-drive-letter access the sandbox denies` | 沙箱令牌严格到足以破坏普通路径规范化 |

**所以 Codex 是四层的**：受限令牌 + 独立账户 + ACL + 防火墙。而且**需要一次性提权**。

### 网络那一层，连它也没完全解决

- 防火墙规则**只能匹配镜像路径，匹配不了受限令牌的身份** → 按镜像的规则**管不住一个能再 spawn 别的二进制的 agent**
- issue [#49840](https://github.com/openai/codex/issues/49840)：离线的防火墙阻断规则**静默地没有重新生效**，且**回环未被挡住**
- 环境变量式的网络抑制被**明确否决**，理由写在博客里：**「恶意 agent 可以轻易绕过基于环境变量的网络抑制」**

### 它的已知问题规模

约 **15 个未关闭的 issue**，覆盖：安装/ACL（[#30445](https://github.com/openai/codex/issues/30445)、[#39245](https://github.com/openai/codex/issues/39245)、[#45734](https://github.com/openai/codex/issues/45734)、[#29867](https://github.com/openai/codex/issues/29867)）、UAC（[#32149](https://github.com/openai/codex/issues/32149)、[#32492](https://github.com/openai/codex/issues/32492)、[#25362](https://github.com/openai/codex/issues/25362)）、**Windows 家庭版专门的支持问题**（[#28730](https://github.com/openai/codex/issues/28730)、[#28566](https://github.com/openai/codex/issues/28566)）、路径/所有权（[#31414](https://github.com/openai/codex/issues/31414)、[#48853](https://github.com/openai/codex/issues/48853)）、打包（[#30732](https://github.com/openai/codex/issues/30732)、[#32655](https://github.com/openai/codex/issues/32655)）。

**这不是个别 bug，这是在 Windows 上做沙箱的真实成本。**

---

## 三、我们的 AppContainer 实测，被发货产品复现

我们实测：AppContainer 免提权可用、能挡读挡写断网，但**执行自带 node.exe 确定性失败**（`Access is denied`），而读同一个文件成功。

**Codex [issue #19271](https://github.com/openai/codex/issues/19271)：**
> 「Windows Codex app: **bundled node.exe fails with Access is denied**」

一模一样。**这不是我们做错了什么，这是 Windows 上 AppContainer 的真实行为。**

---

## 四、我们那次受限令牌失败的正确诊断

结果：进程能创建，但立刻以 `0xC0000022` 死亡。

**根因：restricting SID 列表缺少保活组。**

DSH 的文档写得明确 [一手]：

> 「（令牌的 restricting SID 列表随模式而变；**保活组是登录 SID + Everyone，两种模式下都存在**——没有它们，早期 DLL 初始化会以 `0xC0000142` 死亡，CNG 会让 pwsh 以 `0xE0434352` 崩溃）」

`0xC0000142`（DLL_INIT_FAILED）与 `0xC0000022`（ACCESS_DENIED）是**兄弟错误**——都表示「令牌打不开加载器/CNG 需要的对象」。

正确列表：

| 模式 | restricting SID 列表 |
|---|---|
| `read-only` | `(登录 SID, Everyone)` |
| `workspace-write` | `(登录 SID, Everyone, 工作区 SID, 临时目录 SID)` |

另有两点必须做：
- `Authenticated Users` **必须不在**两个列表里（否则 C:\ 根目录有一个真实的写逃逸）；代价是 CIM / `Get-ComputerInfo` 不可用
- 必须调用 `setTokenDefaultDaclGrant`，把一个 restricting SID 的 ACE 合并进令牌的**默认 DACL**，否则令牌新建的对象（如匿名管道）在创建时就通不过写检查

> ⚠️ **澄清一个误报**：调研提到上游参考 POC 是 **fail-open** 的（忽略所有返回值，`CreateRestrictedToken` 失败时静默用完整无限制令牌跑子进程）。**我们的探针不是 POC 写的，是 fail-closed 的**（每个返回值都检查、失败即抛）。这一点不应混淆。

---

## 五、三条对实现有直接影响的硬约束

1. **受限进程内无法用管道捕获孙进程输出。** libuv 的管道 stdio 用**命名管道**，其默认 SD 模板（KernelBase 安装的，非令牌默认 DACL）不给 restricting SID 写权限 → `spawn(..., { stdio: 'pipe' })` 以 `EPERM` 失败。**inherit（fd）与 ignore 可用**；匿名管道（`CreatePipe`）可用。
   → **任何必须捕获输出、且会在受限进程内再 spawn 的工具，在受限下跑不了。** 我们的 `run_command` 用的是 fd 重定向，**可用**。

2. **控制台隔离不可用。** `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` 的子进程以 `STATUS_DLL_INIT_FAILED` 死亡；POC 尝试加控制台登录 SID `S-1-2-1` 也失败（在 Windows 11 26200 上 `CreateWellKnownSid(WinLocalLogonSid)` 返回 `ERROR_INVALID_PARAMETER`）。子进程共享宿主控制台；stdio 重定向走管道不受影响。

3. **ACL 撤销必须走 API。** `icacls <dir> /remove '*S-1-4-…'` 在本平台实测失败（`ERROR_NONE_MAPPED` 1332）。

---

## 六、这意味着什么

**「本地 + 真实边界」这个要求在 Windows 上处于整个行业的前沿，而不是一个已有标准答案的问题。**

- 大厂的选择是**回避**：Claude Code 和 Cursor **明确不支持 Windows**，让用户走 WSL 或不沙箱。
- 唯一做到完整覆盖的 Codex **要一次性提权**，并承担约 15 个未关闭的安装问题。
- 唯一做到**免提权**的是 DSH，但**只限写**，且自报 `enforcement: 'partial'`。

**因此对任何要分发到终端用户机器的产品，现实只有两条：**

| | DSH 式（免提权） | Codex 式（一次性 UAC） |
|---|---|---|
| 原语 | `WRITE_RESTRICTED` 令牌 | 专用沙箱账户 + `CreateProcessWithLogonW` + ACL + 防火墙 |
| 隔离强度 | **仅写**；读/网络/进程可见性开放 | 写 + 网络 |
| 管理员 | **不需要** | 安装期一次性 |
| 诚实标签 | `enforcement: 'partial'` | 「elevated sandbox」 |
| 已知成本 | 读不到凭据**做不到** | 约 15 个安装期问题，家庭版问题尤其集中 |

**并且无论选哪条，「恢复」层都是必需的**——因为预防在 Windows 上对所有人而言最好也只是 partial。参见 `docs/design-notes-sandbox-permissions-reversibility.md`。

---

## 七、明确未验证

- **任何产品的「是否需要重启」**——检索到的所有来源都没有提到重启。**按「未确定」处理，不要猜「不需要」。**
- **各官方文档页的正文**——本次调研中 `web_search` 只返回标题与 URL 锚点，本地直连被网络策略阻断，因此多数结论基于锚点文字、issue 标题与本地一手文件，而非完整正文。
- **Codex 的确切最低 Windows 版本与 SKU 要求**——相关 PR 存在但正文未读到；家庭版的 issue 只是提示性证据。
- **`CodexSandboxOffline` 这个账户名是否存在**——`CodexSandboxOnline` 由 issue 标题确认，离线版本是我的推断。
- **`web_search` 本次未返回任何 snippet**，部分「引文」来自搜索结果标题与翻译后的锚点，已逐条标注。
- **最高价值的下一步**：在有正常外网出口的机器上读 `learn.chatgpt.com/docs/windows/windows-sandbox.md` 与 `openai.com/index/building-codex-windows-sandbox/`，可一次解决上述多数疑问。
