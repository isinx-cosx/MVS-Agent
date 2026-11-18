# MVS Agent

注：这份 README 的模块与文件表是**按当前代码树逐项核对后写的**（`src/` 下 14 个模块、`ui/` 下 16 个文件）。若日后与代码不符，以代码为准，也请在官网告诉我们 —— 文档腐烂比代码 bug 更难发现。

联系我们：https://mf-vis-science.cn/

通用 Agent 内核：模型层、工具层、沙箱、权限、审核、恢复、上下文，都在本地进程里跑，界面是一个 React 单页。

---

## 导航：从哪读起

这份 README 只做两件事：**介绍项目**、**把你送到该去的地方**。细节在 `docs/` 与代码注释里 —— 本仓库注释密度是有意的，每个结论旁边都写着"为什么"。

### 文档（`docs/`）

| 文件 | 讲什么 |
|---|---|
| [`更新公告.md`](docs/更新公告.md) | 每次改了什么、为什么、怎么验证 |
| [`架构-现状.md`](docs/架构-现状.md) | 模块划分与数据流 |
| [`安全边界-现状.md`](docs/安全边界-现状.md) | 挡得住什么、挡不住什么（附实现位置） |
| [`挡不住清单.md`](docs/挡不住清单.md) | 沙箱的实测反例，逐条带证据等级 |
| [`后端缺陷清单.md`](docs/后端缺陷清单.md) | 已知缺陷、优先度、修复方案 |
| [`沙箱替代方案.md`](docs/沙箱替代方案.md) | 没有 AppContainer 时能退到什么程度 |
| [`sandbox-platform-matrix.md`](docs/sandbox-platform-matrix.md) | 各平台沙箱能力的实测矩阵 |
| [`os-sandbox-findings.md`](docs/os-sandbox-findings.md) | 操作系统级隔离的调研结论 |
| [`design-notes-sandbox-permissions-reversibility.md`](docs/design-notes-sandbox-permissions-reversibility.md) | 沙箱、权限、可逆性的设计取舍 |
| [`输出审核.md`](docs/输出审核.md) | 敏感内容的判定与打码规则 |
| [`破坏性与资源护栏.md`](docs/破坏性与资源护栏.md) | 熔断、配额、超时、进程上限 |
| [`技能与插件设计.md`](docs/技能与插件设计.md) | 技能与插件的发现、审批、执行模型 |
| [`状态迁移与令牌默认.md`](docs/状态迁移与令牌默认.md) | 状态目录迁移、访问令牌默认值 |
| [`行为评估.md`](docs/行为评估.md) | 评估用例与判据 |
| [`待办与紧急度.md`](docs/待办与紧急度.md) | 还没做的事，带紧急度 |
| [`_attic/`](docs/_attic) | **已作废**，只在考据历史时读 |

### 后端（`src/`，14 个模块）

| 模块 | 职责 | 主要文件 |
|---|---|---|
| `src/model/` | 与模型通信：请求组装、SSE 流、用量与成本、窗口探测 | `openai-compatible.ts`、`sse.ts`、`probe.ts`、`cost.ts` |
| `src/tools/` | 工具实现与注册表：文件、命令、搜索、作业、子 Agent | `index.ts`、`registry.ts`、`command-tool.ts`、`agents.ts`、`job-tools.ts` |
| `src/sandbox/` | AppContainer 创建与能力（专属 SID、断网） | `appcontainer.ts`、`profile-sid.ts` |
| `src/policy/` | 权限模式、规则、熔断器、网络策略 | `policy.ts` |
| `src/guard/` | 输出审核、taint、解码/分段判据、可见性门槛 | `review.ts`、`scan.ts`、`state.ts`、`reveal-code.ts` |
| `src/recovery/` | 事务快照与撤销（含 NTFS 备用数据流） | `guard.ts`、`snapshot.ts`、`diff.ts`、`ads.ts` |
| `src/context/` | token 估算、校准与两级压缩 | `tokens.ts`、`calibration.ts`、`compact.ts` |
| `src/host/` | 会话生命周期、投影、本地 HTTP/WS 服务 | `session.ts`、`server.ts`、`runtime.ts` |
| `src/config/` | 配置读写、迁移、密钥来源解析 | `resolve.ts`、`store.ts`、`migrate.ts` |
| `src/protocol/` | 客户端与宿主之间的消息与投影类型 | `types.ts`、`projection.ts` |
| `src/cli/` | 入口命令（`serve`、`chat`、`sandbox:grant` 等） | `serve.ts`、`chat.ts`、`sandbox-grant.ts` |
| `src/skills/` | 技能的发现、前置元数据、库、提示注入 | `discover.ts`、`frontmatter.ts`、`library.ts`、`prompt.ts` |
| `src/plugins/` | 插件清单校验、指纹、执行、参数与密钥注入 | `manifest.ts`、`exec.ts`、`fingerprint.ts`、`library.ts` |
| `src/eval/` | 评估集与评分 | `run.ts`、`assert.ts`、`scripted.ts` |

（`src/replica/` 是空目录，不算模块。）

### 界面（`ui/`，16 个文件）

| 文件 | 职责 |
|---|---|
| `App.tsx` | 主体结构：侧栏、对话区、顶部栏、执行过程块、输入区、审核统计 |
| `useSession.ts` | 会话状态机：投影同步、事件流、命令发送、轮次计时 |
| `client.ts` | HTTP / WebSocket 传输与客户端消息类型 |
| `Settings.tsx` | 设置页：主题、字号、渲染开关、模型、技能、插件 |
| `markdown.tsx` | Markdown 渲染（代码高亮、数学、图片策略） |
| `styles.css` | 全部样式；设计变量集中在文件顶部 |
| `brand.tsx` | 品牌图形的内联 SVG |
| `settings.ts` | 界面偏好的读写与默认值 |
| `model-choice.ts` | 模型下拉的分组与去重 |
| `math.ts` | 数学公式渲染 |
| `stick.ts` | 滚动贴底（stick to bottom）逻辑 |
| `useIndex.ts` | 投影索引（按消息 id 定位） |
| `useJitter.ts` | 流式输出的抖动平滑 |
| `useThrottled.ts` | 节流小工具 |
| `main.tsx`、`index.html` | 挂载点与页面骨架 |

界面通过 `node tools/build-ui.mjs` 打包进 `web/`，服务端按请求从磁盘读 —— **改完界面必须重新构建**，否则浏览器拿到的是旧产物。

---

## 路线图：界面的插件系统

后端已经有一套可用的插件机制（声明式 `plugin.json`、`run.argv` 执行、路径参数先校验再替换、密钥只在声明后注入、超时与输出上限都有限制），见 `src/plugins/` 与 [`docs/技能与插件设计.md`](docs/技能与插件设计.md)。

界面侧目前只做到**"能列出、能审批、能启停"**。下一步是把插件的**界面部分**补齐：让插件能声明自己的面板、命令入口与状态展示，形成**完整的插件系统**（后端 + 界面一体）。

具体形态暂时保密；设计定稿后先写进 `docs/技能与插件设计.md`，再动代码。

---

## 快速开始

```powershell
# 1. 起服务（开发阶段可以不带令牌；默认要求令牌）
node src/cli/serve.ts --port 3080 --no-token

# 2. 浏览器打开
#    http://127.0.0.1:3080/

# 3. 改完界面重新构建（否则浏览器还是旧产物）
npm run ui:build
```

沙箱授权（新机器第一次，**管理员** PowerShell）：

```powershell
npm run sandbox:grant -- .
```

它给工作区加可写 ACE、给祖先链加穿过权限、给 `C:\Program Files\nodejs` 加只读可执行。`git` / `npm` 这类开发工具按设计跑在沙箱外（结果标 `sandbox: off-tool`），不需要为它们改盘根权限。

---

## 三条不可动摇的设计决定

1. **工具调用必须可审计** —— 每次调用都进日志，参数与结果都能回看。
2. **变更有基线** —— 恢复层在每次变更型调用前后拍快照，撤销不是"尽力而为"。
3. **不确定的事必须说出来** —— 宁可显示"未配置"、"选不出来"，也不给一个看起来正常的假值。

---

## 验证

```powershell
npm test          # 615 项，无需网络与 API key
npx tsc --noEmit  # 类型检查
node tools/check-tools.mjs
```

`test/docs-claims.test.ts` 会核对文档里引用的源码路径是否真实存在。这条测试是有来历的：安全文档曾经写着「AppContainer 在 `src/` 里一处都没有」，把"这个项目没有隔离"写进了正式文档 —— 而 `src/sandbox/appcontainer.ts` 一直在那儿。
