# AGENT.md —— 在这个仓库里干活必须知道的

> 这是**开发规范**，不是架构说明。架构与设计取舍见 [README.md](README.md)。
> 这份文件只回答一件事：**怎么改这里的代码才不会把已经修好的东西弄坏。**

---

## 一、当前形态（先看这一节，别凭印象）

**这是一个本地 Agent 内核 + 自己手写的 React 界面。**

```
ui/         手写的 React（TSX）—— App.tsx 88 KB、Settings.tsx 39 KB
web/        ui/ 的构建产物（esbuild），守护进程服务这一份
src/        14 个模块，见下表
test/       39 个文件 / 570 条测试
dist/       另一种打包产物
eval/ learn/ scripts/ tools/ docs/
```

**没有构建步骤跑服务端**：Node 直接跑 `.ts`（v26 原生类型剥离）。
**界面要构建**：`npm run ui:build`（esbuild，`ui/` → `web/`）。

### src 的 14 个模块

| 模块 | 干什么 |
|---|---|
| `src/host` | 守护进程、会话、运行时、WebSocket |
| `src/tools` | 内置工具（`read_file` / `edit` / `grep` / `run_command` / `web_fetch` …） |
| `src/config` | 配置读写、解析、状态 |
| `src/policy` | 权限判定（`read-only` / `workspace-write` / `full-access`） |
| `src/guard` | 输出审核、扫描 |
| `src/skills` | 技能发现与加载 |
| `src/eval` | 行为评估（脚本化断言） |
| `src/plugins` | 插件发现、执行、指纹 |
| `src/replica` | `glue.js` —— 界面与守护进程之间的接线 |
| `src/model` | 模型客户端（OpenAI 兼容） |
| `src/context` | 上下文压缩、token 估算 |
| `src/recovery` | 文件改动撤销 |
| `src/protocol` | 协议类型（两端共享） |
| `src/cli` | 9 个命令行入口 |

---

## 二、一分钟上手

```bash
npm run serve         # 守护进程
npm run ui:build      # 改过 ui/ 之后必须跑
npm test              # 570 条
npm run typecheck     # tsc --noEmit（服务端）
npm run ui:typecheck  # tsc -p tsconfig.ui.json（界面）
```

**⚠️ `npm run typecheck` 只查服务端那份。** 界面是 `ui:typecheck`。两份都要过。

**⚠️ 测试命令带 `--import ./test/setup.mjs`** —— 不是裸的 `node --test`。

---

## 三、硬约束

### 1. 服务端没有 DOM

`tsconfig.json` 的 `lib` **刻意不含 DOM**。

```ts
// src/host/anything.ts
document.title = 'x'   // ← 类型检查会红，这是对的
```

**不要为了让它过而加 DOM。** 那会让服务端写 `document.` 通过检查、运行时才炸。

界面代码在 `ui/`，归 `tsconfig.ui.json` 管（有 DOM）。

### 2. 运行时依赖只有六个，而且全是为界面

```jsonc
"dependencies": {
  "dompurify", "highlight.js", "katex", "marked",   // 界面的 markdown / 数学渲染
  "react", "react-dom"                              // 界面本身
}
```

**服务端部分仍然是零依赖。** 想在 `src/` 里加一个包之前，先问：Node 自带的能不能写出来。

### 3. 类型必须能被"剥离"

```jsonc
"erasableSyntaxOnly": true,          // 禁止 enum / namespace / 构造函数参数属性
"verbatimModuleSyntax": true,        // 类型导入必须写 import type
"allowImportingTsExtensions": true   // 相对导入必须带 .ts 后缀
```

```ts
import type { Foo } from './foo.ts'   // ✅
import { Foo } from './foo.ts'        // ❌ Foo 是类型的话，剥离后这行还在 → 运行时崩
```

### 4. `.mjs` 文件里不能有 TypeScript

`.mjs` 不被剥离类型。`import type` 放进去是语法错误。

---

## 四、注释：这个项目最鲜明的规矩

**几乎每个 `.ts` 都以 `/**` 开头。** 这不是巧合。

这里的注释**不解释代码在做什么**（读代码就知道），而是解释：

1. **为什么这样，而不是那样** —— 尤其是被否决的替代方案
2. **踩过什么坑** —— 具体到"当时的错误理解是什么"
3. **边界在哪** —— 什么情况下这个方案会失效

### 范例

```ts
/**
 * 一句话说这个模块干什么。
 *
 * ## 一个不那么显然的决定
 *
 * 为什么不按直觉那样做。直觉是什么，为什么它是错的。
 *
 * ## ⚠️ 一处会咬人的地方
 *
 * 具体现象 + 根因。**写清楚"当时我以为是 X，实际是 Y"。**
 */
```

**这个仓库的注释里到处是「我第一版写成 X，于是 Y」—— 那是资产，不是噪音。** 下一个改这段代码的人（或 agent）会重复同样的错误；注释里留着那个错误，他就不用重走一遍。

### 不要写

```ts
// 设置 model 为 value        ← 废话
this.model = value

// TODO: 以后处理             ← 没有信息量
```

---

## 五、代码风格（没有 linter，全靠照抄）

**改哪个文件，就照那个文件的样子写。**

| 项 | 约定 |
|---|---|
| 引号 | 单引号 |
| 分号 | 不写行尾分号 |
| 缩进 | 2 空格 |
| 命名 | 文件 `kebab-case.ts`；类型 `PascalCase`；函数/变量 `camelCase` |

注释和文案用中文，标识符用英文。

### 错误信息：说清楚，不要静默丢弃

**这是这个仓库最容易犯、后果最重的错。**

```ts
// ❌ 静默跳过，然后照样回 ok
const target = FIELD[leaf]
if (target === undefined) continue
```

```ts
// ✅ 攒起来一起报
if (unhandled.length > 0) {
  return { ok: false, error: {
    code: 'replica/unhandled-setting-path',
    message: `不认识这些设置路径：${...}。已拒绝保存 —— 与其显示成功却没存，不如明确报出来。`,
  } }
}
```

**判据**：如果一条路径会让操作被丢掉，它必须能被用户看见。**回 `ok` 却什么都没做，比直接失败糟得多** —— 失败你会知道要改什么；回 ok 你会以为是保存了、刷新发现没有、再试一次、还是这样。

### 三态要分得开

| 值 | 含义 |
|---|---|
| 字段缺省 | 这次不改它 |
| `null` | 显式清掉（回到自动） |
| `''` | 显式清空（密钥不要了） |
| `[]` | 显式一个都不要 |

混掉的话用户就**清不掉**已经存下的东西。

---

## 六、已知陷阱

### ⚠️ 1. PowerShell 会吃掉引号 —— #1 时间黑洞

```powershell
node -e "console.log('a' + /regex/.test(x))"     # ← 引号会被搅碎
node -e "t.includes(\"literal\")"                # ← 更糟
```

现象是 `Expected ',', got 'ident'` 或 `TerminatorExpectedAtEndOfString`，**而报错行号指向被搅碎之后的位置，和你的代码对不上**。

**做法：写成 `.mjs` 文件再跑。**

```powershell
$pid          # ← 只读自动变量，不能当循环变量，用 $procId
Kill          # ← Stop-Process 的别名！不要用这个名字定义函数
$cond ? a : b # ← PowerShell 5.1 不支持三元，用 if/else
```

### ⚠️ 2. `normalizeConfig` 的 `known` 集合

`src/config/store.ts` 末尾有一段逐字段检查：

```ts
const known = new Set(['version','profile','model','server','permissions','context','localModel','webSearch'])
for (const key of Object.keys(input)) {
  if (!known.has(key)) warnings.push(`配置里有不认识的字段「${key}」，已忽略`)
}
```

**加了新的配置段必须加进这个集合。** 漏了的现象是：解析逻辑写得完全正确，但配置**被整个忽略**，而且每次启动多一句「不认识的字段」。

`localModel` 漏过一次，`webSearch` 差点再漏，`providers` / `activeProvider` 也差点。

### ⚠️ 3. `#broadcast` 只过滤 ephemeral 事件

`src/host/server.ts` 里，**流式增量**只发给"声明在看"的连接，**落盘事件**发给所有连接。

漏了 `watch` 的现象：**生成过程一片空白 → 最后整段一次性出现**。它看起来像"模型慢"，不像 bug。

**规矩**：`watch` 是**连接的状态**，不是"切会话那次动作"。每次选中都发（幂等、几十字节），每次重连都重发。

### ⚠️ 4. 工具结果的字段是 `content`，不是 `output`

```ts
result.output      // ❌ undefined
result.content     // ✅
```

### ⚠️ 5. 测试共用一个进程，而且并发

```bash
node --test --test-isolation=none --import ./test/setup.mjs "test/*.test.ts"
```

`--test-isolation=none` 是必须的（这个环境 spawn 子进程被拦）。代价是**所有测试文件共用一个进程并且并发跑**：

- **不要改全局**（`globalThis.WebSocket` 之类）—— 别的文件的用例会跑在你装上和还原之间
- 需要假对象就**注入**（平台能力对象那种做法）

### ⚠️ 6. 写测试前，先找有没有现成的

**踩过一次**：我写了 299 行的测试去测一个模块，而 `test/` 里已经有一份覆盖同样内容。

```powershell
Select-String -Path 'test\*.ts','test\*.mjs' -Pattern '你在测的那个函数名'
```

---

## 七、验证纪律：这个仓库最大的教训

**最贵的一类错误不是写错代码，是「结论建立在没验过的前提上」。**

### 五次真实记录

| 当时的结论 | 实际原因 |
|---|---|
| 「`run_command` 读不到密钥」 | 我的命令双重 shell 包裹了，重写就读到了 |
| 「`--reasoning on` 会打崩服务」 | 是重复 `taskkill` 留下的半死进程 |
| 「守护进程不推 `model_reasoning_delta`」 | 我没发 `watch` 订阅 |
| 「服务的那份文件有我的改动」 | JS 的 `.length` 和文件字节数，单位比错了（中文 1 码元 = 3 字节） |
| 探针「加模型没反应」 | 正则匹配到了**外层**的同名按钮 |

**五次里三次是我自己的工具错，而现象看起来像产品有问题。**

### 规矩

**1. 说"X 不工作"之前，先证明你用的是 X。**

改完代码 → 确认构建产物更新了 → 确认页面拿到了新代码 → 再下结论。

**2. 一个检查通过了，不代表它检查的是你以为的东西。**

**3. 输出形状对不上时，先怀疑自己的解析。**

**4. 探针的选择器/正则要精确。** `/添加模型/` 会匹配到「添加模型**提供商**」。

**5. 量单位要看清。** JS 的 `string.length` 是 UTF-16 码元，文件系统报的是字节。

**6. 仓库可能在动。** 这个仓库有并行的工作在推进 —— 写文档或改代码之前，**先看 `git log` 和 `git status`**，别拿一小时前的印象当真。

---

## 八、提交前必须跑

```powershell
npm test                      # 570 条
npm run typecheck             # 服务端（tsc --noEmit）
npm run ui:typecheck          # 界面（tsc -p tsconfig.ui.json）
npm run ui:build              # 改过 ui/ 就必须重建，否则页面是旧的
node tools/check-tools.mjs    # 工具定义自检
```

**任何一条红都不算做完。**

**改过 `ui/` 却没跑 `ui:build`，是最容易犯的错** —— 页面看起来"没变化"，而代码其实是对的。

---

## 九、不要做的事

### ❌ 不要往 `web/` 里手写文件

`web/` 是 `ui/` 的**构建产物**，`ui:build` 会清掉它。要改界面就改 `ui/`。

### ❌ 不要相信"应该能跑"

跑一遍。**这个仓库里每个"应该"都出过事。**

### ❌ 不要改行为而不改文档

`docs/` 下有十几份现状/设计文档。**过期的文档比没有文档更坏**，因为它会被当成事实引用。

---

## 十、这份文档自己没验证的

写这份文件时我犯了两次错，写下来提醒：

1. **我第一版写的是一小时前的仓库。** 那时界面还是 DSH 的复刻页、`src/` 只有 9 个模块、359 条测试。等我校对时，仓库已经有 `ui/`、14 个模块、570 条测试了 —— **而我在那之前就把文档写完了。**
2. **我写了「零运行时依赖」和两个不存在的脚本名**（`check-served.mjs` / `check-shim-sync.mjs`）。核对时才发现依赖有六个、脚本早没了。

**所以：这份文档里的每一条都应该是能当场复核的。** 如果某条对不上，改它 —— 别照着错的做。

#### 用户提示：若已有计划文档，请直接按文档落地，不要经常停下来询问！！！
