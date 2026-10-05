# Findings

## 关于「用这个仓库教 TS」的可行性

仓库本身是**中级偏上**的 TS，对零 JS 基础的人不可直接当教材。证据（读源码得到）：

| 文件 | 用到的语法 | 难度 |
|---|---|---|
| `src/tools/schema.ts` | `Record<string, unknown>`、类型谓词 | 入门偏中 |
| `src/model/sse.ts` | `AsyncGenerator`、`TextDecoder` | 中偏上 |
| `src/tools/types.ts` | `Tool<A = unknown>` + `run(args: never)` 逆变擦除 | 高 |
| `src/host/session.ts` | `#private`、`AsyncIterable`、判别联合、闭包捕获 | 高 |
| `tsconfig.json` | `erasableSyntaxOnly`、`verbatimModuleSyntax` | 高（概念性） |

→ 结论：仓库作为**动机与终点**，前 6 课另写小文件。

## 环境事实（已验证）

- `node -v` = **v26.3.1**，`.ts` 直接用 `node file.ts` 跑，**类型被剥离**，无需编译/安装。
- 因此教学反馈循环极短：改一行 → 重跑 → 看到结果。这是这套课程最大的便利。
- ⚠️ 代价：**Node 不做类型检查**。写 `let n: number = '三十'` 照样跑。
  这正好是第 2 课要回答的问题「那谁负责抓这个错」→ 引到 `tsc --noEmit`。

## C++ → JS/TS 的映射表（讲课时反复用）

| C++ 概念 | JS/TS 对应 | 关键差异 |
|---|---|---|
| `const T` | `const` | **完全不同**：JS 的 const ≈ `T* const`，只锁绑定 |
| `nullptr` | `null` + `undefined` | 两个空值，语义不同 |
| 拷贝构造 | 展开运算符 `{...x}` / `[...xs]` | **没有自动拷贝**，赋值即共享 |
| `auto b = a`（值语义） | `const b = a`（引用语义） | 默认共享，最反直觉的一条 |
| 析构函数 / RAII | 无 | 靠 GC + 显式 `try/finally` |
| 模板实例化 | 泛型 | **无代码生成**，类型运行时被擦除 |
| 名义类型 | **结构化类型** | 形状相同即可互赋 |
| 线程 / mutex | 单线程事件循环 | 没有并发，只有异步 |
| 编译期错误 | `tsc` 检查 | 但执行时检查被跳过（Node 剥类型） |

## 这个仓库里能当教学素材的「活教材」

- `schema.ts` 手写 JSON Schema 校验器 → 演示**类型擦除的代价**（类型运行时不存在，所以要手写运行时校验）
- `command-tool.ts` 的 `try/finally { closeSync(...) }` → 演示**没有 RAII 怎么补**
- `model/types.ts` 的 `ModelEvent` → 判别联合的教科书案例
- `session.ts` 的 `#runLoop` → 前面所有知识的综合应用
