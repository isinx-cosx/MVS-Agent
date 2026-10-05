# Windows OS 级沙箱可行性实测

**结论：在「免管理员权限 + 本地执行 + 跑真实工具链」这个组合下，Windows 上没有可行解。**

两条最可行的免提权路线都实测否定了。以下是方法与数据。

---

## 需求背景

MVS Agent 定位为**面向所有 AI 用户的桌面产品**，且**命令执行是核心能力**。约束：

- 用户机器不可控，很多是非管理员账户
- 不能要求用户开 Hyper-V、装 Docker、重启电脑
- 要求：**本地执行，但必须有真边界**

---

## 实测环境

| 项 | 值 |
|---|---|
| OS | Windows 11 专业版，Build 26100 |
| 账户 | 在 Administrators 组，**当前进程未提权** |
| 完整性级别 | Medium |
| HypervisorPresent | **False** |
| WSL2 / Docker / Windows Sandbox | **均未安装** |

注：`IsInRole(Administrator)` 为 False 只说明当前未提权，不代表账户不是管理员。两者影响完全不同，必须分开判断。

## 方法

用 PowerShell 的 `Add-Type` 内联 C# 做 P/Invoke，绕过「npm registry 不通、装不了 FFI 库」的限制，直接调 Win32：

- AppContainer：`CreateAppContainerProfile` + `InitializeProcThreadAttributeList` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` + `CreateProcess`
- 受限令牌：`OpenProcessToken` + `CreateRestrictedToken` + `CreateProcessAsUserW`
- `icacls` 配置 ACL

---

## 路线一：AppContainer

### 机制本身：全部通过

| 检查 | 结果 |
|---|---|
| **不提权**创建 AppContainer profile | ✅ |
| **不提权**在容器内启动进程 | ✅（`cmd.exe /c exit 42` → 42） |
| 读用户目录文件 | ✅ **被拒** |
| 读 `C:\Windows\win.ini` | ⚠️ 允许（System32 有 `ALL APPLICATION PACKAGES` 授权） |
| 写授权目录之外 | ✅ **被拒** |
| 写授权目录之内 | ✅ 成功 |
| 回环 TCP | ✅ **被拒** |

**隔离效果正是我们想要的形状**：挡用户数据、放行系统工具、断网。

### 但跑不了工具链

把 `node.exe` 放进用户自有目录，递归授予容器 SID `(OI)(CI)F`，ACL 确认无误：

```
node.exe ACL: S-1-15-2-...(I)(F) + SYSTEM + Administrators + 当前用户
```

结果（每项重复 5 次，**全部确定性复现**）：

| 操作 | 5 次结果 | 判定 |
|---|---|---|
| 读文件（`copy node.exe`） | 0,0,0,0,0 | **成功** |
| 写文件 | 0,0,0,0,0 | **成功** |
| 列目录（`dir`） | 1,1,1,1,1 | **确定失败** |
| 执行 `node -v` | 1,1,1,1,1 | **确定失败** |
| `where.exe cmd` | 1,1,1,1,1 | **确定失败** |

**规律：文件读写可以，目录枚举和映像加载不行。** 不是随机失败，是结构性的。

试过并排除的变量：ACL 授 `RX`（只读+执行）、授 `F`（完全控制）、加 `/T` 强制已有子项、把运行时可写位置改成只读、祖先目录遍历授权（该次探针在 `icacls` 环节超时，未出结果）。

**失败模式是「Access is denied」+ 行为不跟随 ACL**，根因未查明。

---

## 路线二：受限令牌（restricted token）

Windows 最经典的特权分离机制。思路：从自己的令牌派生一个 SID 受限令牌（限制集 = `BUILTIN\Users`），让有效权限变成**交集**：

- 用户目录 ACE 只授权给本人 → 不在限制集 → 读不到
- System32 授权给 `Users` → 在限制集 → 能执行
- 工作区显式授权 `Users` → 能读写

按 MSDN，令牌是**自己主令牌的受限版**时，`CreateProcessAsUser` 不需要 `SeAssignPrimaryTokenPrivilege`。

### 结果

- ✅ `CreateProcessAsUser` **没有抛异常** —— 免提权这一点成立
- ❌ 但子进程对**任何**命令都返回 `-1073741790` = `0xC0000022` = **STATUS_ACCESS_DENIED**

也就是：**进程能创建，但一启动就死。** 连 `cmd.exe /c ver` 都不行。

（受限令牌进程通常因为无法访问窗口站/桌面而立刻退出，这是该机制的已知摩擦点。）

---

## 完整图景

| 方案 | 真边界 | 免提权 | 能跑真实工具链 | 状态 |
|---|---|---|---|---|
| **AppContainer** | ✅ | ✅ | ❌ | **实测否定** |
| **受限令牌** | ✅ | ✅（创建成功） | ❌ | **实测否定** |
| 低完整性 (Low IL) | 半（只挡写） | 需 native | — | 挡不住读 |
| Job Object | ❌ 非安全边界 | 需 native | — | 只做进程树治理 |
| 独立用户账户 | ✅ | ❌ 创建需提权 | 大概率 ✅ | **唯一未测**（本机无法测） |
| WSL2 / Docker | ✅ | ❌ 需提权+重启 | ✅ | 不能要求终端用户 |
| Windows Sandbox | ✅ | ❌ 需提权 | ✅ | 太重 |

**免提权的跑不了工具链；能跑工具链的全都要提权或重启。**

---

## 唯一还没测的路线：独立用户账户

**这条没法在本机验证，因为创建本地用户需要管理员权限。**

思路（供后续验证）：

1. **安装时（一次性提权，桌面软件安装器的正常行为）**
   - 创建本地低权限用户 `MVS-Sandbox`，设置随机密码
   - 用 DPAPI 把凭据加密存给当前用户
   - 只给该用户授予沙箱根目录的修改权限
   - 加防火墙规则，按用户阻断出站（`New-NetFirewallRule -LocalUser`）
2. **运行时（不需要提权）**
   - 用 `CreateProcessWithLogonW` 以该用户身份启动命令
   - 该 API 对非特权调用者可用，不需要 `SeAssignPrimaryTokenPrivilege`

**为什么这条比前两条更有希望**：AppContainer 是给**打包应用**设计的（微软并未支持在其中跑任意工具链），受限令牌是遗留机制且有桌面访问问题；而「换个用户跑」是 Windows **通用**的特权分离手段，设计目的就是这个。

**风险**：不同用户意味着拿不到开发者的用户级配置；首次登录要建用户 profile，较慢；沙箱用户与真实用户之间传文件需要走沙箱根目录。

---

## 由此推出的产品结论

1. **不要指望 Windows OS 沙箱兜底。** 两条最可行的路线都实测否定了，第三条需要安装期提权且未验证。

2. **应用层围栏只能防手滑。** 已有的路径围栏有价值，但文档和 UI 里**不许写「安全模式」**——那个谎会在用户丢文件那天讨回来。

3. **可逆性 > 预防。** 拦不住就保证能撤：破坏性操作前快照，UI 提供撤销。这是不可控机器上唯一站得住的承诺，且**跨平台都成立**。

4. **真边界只对能装 Docker/WSL 的用户开放**，作为高级选项，如实标注前提。

5. **平台不对称要如实呈现**：Linux 有 Landlock、macOS 有 `sandbox-exec`，都是免提权的。所以做本地沙箱会得到一个「三平台里两个有边界」的产品。

6. **唯一「零前提 + 真隔离 + 跨平台一致」的是 WASM**，但它是沙箱化计算，不是 shell。

---

## 复现要点

- 用 `Add-Type` 内联 C# 做 P/Invoke，不依赖任何需要安装的包
- 每次探针结束后**必须清理 AppContainer profile**（用 `DeleteAppContainerProfile`）
- ⚠️ **不要把清理调用包在静默的 `try/catch` 里**。这次 9 个探针 profile 全部残留而没有任何提示——静默失败掩盖了资源泄漏。这是产品级的教训，不是脚本的小问题。
- ⚠️ **`.ps1` 必须存为带 BOM 的 UTF-8 或纯 ASCII**。Windows PowerShell 5.1 会把无 BOM 的 UTF-8 按 ANSI/GBK 解码，中文字符被解坏后破坏字符串边界并导致解析错误。
- ⚠️ 探针应在 `C:\Users\Public\<name>` 下建沙箱根目录：`BUILTIN\Users` 在那里本来就有权限，可以避免改动用户目录的 ACL（给用户目录跑 `icacls` 时曾出现超时）。
- PowerShell 里 `Try` 是保留字，不能用作函数名。
