# 变更记录

只记**影响安全边界或外部行为**的改动。内部重构、文档润色不列。

## 沙箱

- **默认开启**：不设变量即走沙箱（AppContainer 断网 + Job 上限）；`MVS_SANDBOX=off` 才关。
  测试入口统一设 `off`，需要沙箱的用例自己 `withSandbox()` 打开。
- **后台作业进沙箱**：作业跑在带 `--stream` 的 worker 里，断网 + 只写工作区，日志仍流式；
  `job_kill` 杀 worker → `KILL_ON_JOB_CLOSE` 连带杀树。
- **专属 AppContainer SID**：授权不再用 `S-1-15-2-1`（所有 AppContainer），改为查注册表映射
  拿本 profile 的 SID。实测：撤掉宽 ACE 后沙箱仍能读工作区。
- **`%TEMP%` 不再授权**：容器把 `TMP`/`TEMP` 重定向到私有目录；job 模式则指到工作区内。
- **写字节窗口收紧**：轮询 50 ms → 10 ms（前 2 秒）→ 50 ms 退避。
- **分级降级**：AppContainer 起不来时退回受限令牌 + Job（仍有进程/内存/CPU/写字节上限），
  结果里明确写"断网与写隔离未生效"。
- **后台作业不再静默绕过**：以前只发警告，现在真的在沙箱里。
- **注册表 / 剪贴板：原生 exe 也挡得住**（实测 `reg.exe` 拒绝访问、`powershell Get-Clipboard` 抛 `ExternalException`）。
- **句柄隔离改为双向验证**：父进程侧枚举子进程句柄表（`NtQuerySystemInformation`），对照里句柄在、沙箱里不在。

## 输出审核（读出上下文之前）

- **敏感路径只给元信息**：`.env` / 私钥等只回 `{字节数, 行数}`，不给内容、不给哈希
  （哈希是判定器，可被猜值验证）。
- **`revealSensitive` 必须人工批准**：交互走审批；非交互须用 `npm run reveal:code`
  生成的一次性码（5 分钟、一次、只存哈希、猜错即废）。
- **多层编码**：最多解 3 层；任一层命中即整段扣留。
- **二进制**：base64 里的 PNG/JPEG/PDF/ZIP/GZIP 整段扣留；`read_file` 读二进制只给元信息。
- **分段拼接**：按来源记最近 8 段短 blob，拼连续后缀后解码再扫。
- **片段判据**：完整 base64 必是 4 的倍数，不是的标为"可能是被切开的片段"。
- **分片读取检测**：同一文件被反复窄切片（≥3 次且平均 <10 行 / 覆盖≥30% / ≥8 次）→ 降级为元信息。
- **每轮读取预算**：5000 行，超限后本轮剩余读取只给元信息。
- **审核状态落盘**：分片计数与解码窗口写 `.mvs/review-state.json`，重启不重置。
- **`review_stats` 事件**：每轮结束时汇总挡下了什么（secrets/pii/encoded/fragments/chunked/withheld）。

## 恢复层

- **taint 覆盖 shell 写**：命令改过模型没看过的文件 → 自动还原并报 `tainted_write_via_command`。
- **ADS 可见**：快照记 `streamCount`，只改 ADS 也会产生事务；流内容快照到 `.mvs/ads/<事务>/`，
  `npm run ads:restore -- <事务 id>` 写回；超 1 MB 未快照的会明示而不是静默跳过。

## 策略层

- **网络白名单**：`MVS_ALLOW_NET=npm,pip` 只放行匹配命令；`=1` 仍为全放行（钝的那种）。

## 运行时

- `.mvs/` 不再进版本库（taint、审核状态、一次性码、ADS 快照、事务历史都在里面）。
