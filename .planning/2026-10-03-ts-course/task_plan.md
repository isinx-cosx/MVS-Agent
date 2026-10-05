# Task Plan: 用 MVS Agent 教一位 C++ 程序员学 TypeScript

## Goal

让一位**有 C++ 基础、零 JS/TS 基础**的学习者，从零走到能独立读懂并修改 `MVS Agent` 仓库里的 TypeScript 代码。

## 学习者画像（决定一切的前提）

- **会**：C++（静态类型、编译期检查、值语义、RAII、模板、vtable）
- **不会**：JS、TS，任何动态语言经验
- **要**：系统课程，不是零散知识点

> ⚠️ 这条画像是整个课程的设计依据。所有讲解都从 C++ 的已知概念**映射**过来，
> 并且**优先讲「会咬到你」的差异**，而不是平铺直叙语法。

## Current Phase

Phase 1

## Phases

### Phase 0: 三个会立刻咬你的差别（JS 心智模型）

> 目标：跑通第一个 `.ts`，并认出 `const`、两个空值、引用语义这三个 C++ 惯性陷阱。

- [ ] 课 1：跑起来 + `const` 陷阱 + `null`/`undefined` + 引用语义
- [ ] 课 2：原始类型 vs 对象，没有拷贝构造，怎么真正复制
- [ ] 课 3：函数是一等公民、闭包、箭头函数
- **Status:** in_progress

### Phase 1: 值、数组、对象

- [ ] 课 4：数组与常用方法（`map`/`filter`/`reduce`）
- [ ] 课 5：对象、解构、展开运算符
- [ ] 课 6：相等性 —— `==` 与 `===`，为什么这个仓库一律用 `===`
- **Status:** pending

### Phase 2: TS 的类型标注

- [ ] 课 7：`interface` vs `type`，类型注解，可选属性
- [ ] 课 8：联合类型、字面量类型（`'read' | 'write' | 'execute'`）
- [ ] 课 9：结构化类型 —— TS 不是 C++ 的名义类型（**最反直觉的一课**）
- **Status:** pending

### Phase 3: 判别联合与收窄（这个仓库的核心模式）

- [ ] 课 10：判别联合 —— 用 `switch` 让编译器穷尽检查
- [ ] 课 11：类型收窄、类型谓词 `value is T`
- [ ] 课 12：读真实代码 `src/model/types.ts` + `src/protocol/projection.ts`
- **Status:** pending

### Phase 4: 泛型与类型擦除

- [ ] 课 13：泛型（对比 C++ 模板：**TS 泛型没有代码生成**）
- [ ] 课 14：为什么这个仓库要手写 `schema.ts` 运行时校验器（类型擦除的代价）
- **Status:** pending

### Phase 5: 异步 —— C++ 人最容易翻车的地方

- [ ] 课 15：单线程与事件循环（没有线程、没有 mutex）
- [ ] 课 16：`Promise` 与 `async/await`
- [ ] 课 17：`AsyncGenerator` —— 读懂 `ModelClient.stream()`
- [ ] 课 18：`AbortController` —— 异步世界里怎么「取消」
- **Status:** pending

### Phase 6: 读懂真实代码

- [ ] 课 19：`src/model/sse.ts`（跨 chunk 缓冲，纯逻辑，无异步）
- [ ] 课 20：`src/tools/registry.ts` + `schema.ts`（异常收敛边界）
- [ ] 课 21：`src/host/session.ts` 的 `#runLoop`（全都在前面学过）
- **Status:** pending

### Phase 7: 这个仓库的高级手法

- [ ] 课 22：`#private` 字段（真私有）vs C++ `private`
- [ ] 课 23：`AnyTool.run(args: never)` 的逆变擦除技巧
- [ ] 课 24：`erasableSyntaxOnly` 与 `verbatimModuleSyntax` —— 为什么源码能直接跑
- **Status:** pending

## Key Questions

1. 学习者会不会自己想动手改代码？（决定练习的密度）—— 待第 1 课后观察
2. C++ 里最熟的是哪一块？（模板 / 系统编程 / 面向对象）—— 决定用哪类类比
3. 每课多长合适？—— 默认 15-25 分钟，可调整

## Decisions Made

| Decision | Rationale |
|---|---|
| 课程代码放 `learn/`，不碰 `src/` | `src/` 是被测试和结构守卫盯着的生产代码，教学脚本不该污染它 |
| 每课一个可运行 `.ts` 文件 | Node 26 直接剥类型执行，**零编译步骤**，改一行就能看到结果，反馈循环最短 |
| 前 3 课不碰这个仓库的真实代码 | 学习者零 JS 基础，直接读 `#private` + `AsyncGenerator` 会崩。仓库是**终点和动机**，不是起点 |
| 每个概念先给 C++ 对照 | 学习者的已有心智模型是最强的教学杠杆，也是最大的误解来源 |
| 不教 `var` | 已过时且会强化错误心智模型；只教 `const`/`let` |
| 不教 `enum` | 这个仓库的 tsconfig 禁用了它（`erasableSyntaxOnly`）；直接用联合类型，和仓库一致 |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| （暂无） | | |

## Notes

- 课程进度写在 `progress.md`，跨会话可恢复
- 学习者的背景与偏好已记入 memory，新会话不必重问
- **每课结束必须让学习者真的跑一次代码**，只读不跑等于没学
