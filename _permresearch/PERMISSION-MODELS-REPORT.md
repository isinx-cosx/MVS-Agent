# Permission & Approval Models of Shipped AI Coding Agents

Research notes for designing a permission layer. Sources verified by direct fetch of official docs on the date of research; every claim is marked primary (official) or secondary.

Legend: **[OFFICIAL]** = fetched from the vendor's own docs. **[SECONDARY]** = third-party page. **[UNVERIFIED]** = could not confirm.

---

## 1. Comparison table

| Product | Default posture | Allowlist mechanism + matching granularity | Modes | Escape hatches |
| :-- | :-- | :-- | :-- | :-- |
| **Cursor (IDE agent)** | Terminal commands need approval; **workspace file edits do NOT** (saved to disk immediately); reads/searches free; each MCP call prompts; no arbitrary network. **[OFFICIAL]** | `permissions.json`: `terminalAllowlist` — **prefix match on the command string, case-sensitive**; `npm:install*` uses `:` to split base command from an args glob. `mcpAllowlist` — `server:tool`, case-insensitive, `*` wildcard either half, globs inside names. **No denylist key exists in the schema.** **[OFFICIAL]** | Run Modes (3.6+): **Auto-review** (recommended default), **Allowlist**, **Run Everything**. `Ask Every Time` deprecated in 3.5; `Run in Sandbox` folded into Allowlist. **[OFFICIAL]** | Run Everything; `sandbox.json` network "Allow All"; CLI `--force`/`--yolo`; hooks returning `permission: allow`; cloud agents auto-run everything in a VM. **[OFFICIAL]** |
| **Cursor (CLI)** | Separate system from the IDE. `permissions.allow` / `permissions.deny`, deny wins. **[OFFICIAL]** | Claude-Code-style tokens: `Shell(cmd)`, `Read(p)`, `Write(p)`, `WebFetch(domain)`, `Mcp(server:tool)`; globs `**` `*` `?`; `command:args` form (`curl:*`). **[OFFICIAL]** | CLI flags (`--force`), not Run Modes. **[OFFICIAL]** | `--force` (alias `--yolo`), `-p` print mode. **[OFFICIAL]** |
| **Cline** | Everything prompts by default; per-category toggles are off until you enable them. **[OFFICIAL]** | **No fixed allowlist.** The model marks each command with a `requires_approval` flag based on command + arguments; Cline routes on that flag ("safe" vs "requires approval"). **[OFFICIAL]** | Auto Approve per-category toggles; **YOLO mode** (auto-approve everything incl. mode transitions). **[OFFICIAL]** | YOLO mode; Enterprise `yoloModeAllowed: true/false` remote config; SDK `toolPolicies` + `requestToolApproval`. **[OFFICIAL]** |
| **Roo Code** | Per-tile auto-approve, off until enabled. Security warning at top of docs. **[OFFICIAL]** | **Yes — genuine prefix allowlist + denylist.** `roo-cline.allowedCommands` / `roo-cline.deniedCommands`. Precedence: "Deny rules take precedence when their matching prefix is **equally or more specific** than the allow match (**longest-prefix wins**)." Plus a documented **dangerous-substitution guard**. **[OFFICIAL]** | Auto-Approve tiles (8 permissions, each with risk level); All/None bulk chips; global Enabled switch. **[OFFICIAL]** | `*` in the allow list = allow all; global Enabled toggled off; per-tile settings JSON. **[OFFICIAL]** |
| **Claude Code** | **`auto`** is the built-in starting mode for interactive terminal + VS Code sessions on v2.1.283+; earlier versions Manual (`default`). `-p`/SDK default to `default`. **[OFFICIAL]** | `settings.json` → `permissions.allow` / `ask` / `deny`. Rules are `Tool` or `Tool(specifier)`. **Bash: glob `*` over the whole command text**, plus `:*` ≡ trailing ` *`; each subcommand of a compound command must match independently; deny/ask rules look **inside** `$()`, backticks, subshells. Parameter rules `Tool(param:value)` for deny/ask only. **[OFFICIAL]** | Six modes: `default` (Manual), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. **[OFFICIAL]** | `bypassPermissions`; `defaultMode` in settings; `--dangerously-skip-permissions`; `--allowedTools`/`--disallowedTools`; PreToolUse hooks; `autoMode.classifyAllShell`. Each has an admin kill switch. **[OFFICIAL]** |
| **Aider** | **No permission/approval model.** Edits land directly. **[OFFICIAL — by absence]** | None. No allowlist, denylist, sandbox, classifier, or per-tool approval in the options reference, FAQ, git docs, or scripting docs. **[OFFICIAL — by absence]** | Chat modes (`/ask`, `/code`) are about *what the model does*, not permissions. **[OFFICIAL]** | `--yes-always` / `AIDER_YES_ALWAYS` = "Always say yes to every confirmation". Safety is **git**: auto-commit per change + `/undo`; `--no-auto-commits` disables. **[OFFICIAL]** |

---

## 2. Cursor — mechanism detail

### 2.1 There are two unrelated permission systems

This is the single most important thing to get right: Cursor's **IDE agent** and its **CLI** use different files, different schemas, and different matching engines.

- **IDE agent** → `permissions.json` (allowlists + natural-language classifier steering). **[OFFICIAL]** — https://cursor.com/docs/reference/permissions.md
- **CLI** → `~/.cursor/cli-config.json` (global) or `<project>/.cursor/cli.json`. The docs say plainly: "The Cursor CLI has its own permissions system — this file is the editor's." **[OFFICIAL]** — https://cursor.com/docs/cli/reference/permissions.md

### 2.2 `permissions.json` — exact schema

Three optional top-level keys. That is the entire schema. Top level is camelCase; the two keys inside `autoRun` are snake_case. JSONC comments accepted; unknown keys ignored; non-string entries inside an array are **silently dropped**. **[OFFICIAL]**

| Field | Type | What it does |
| :-- | :-- | :-- |
| `terminalAllowlist` | `string[]` | Terminal commands that run without approval. Prefix match, case-sensitive (`git` matches `git status`, not `gitk`). `npm:install*` uses `:` to split the base command from an args glob. |
| `mcpAllowlist` | `string[]` | MCP tools, written `server:tool`. Case-insensitive; `*` wildcards either half (`github:*`, `*:list_issues`, `*:*`); globs inside names (`my-server:list_*`). An entry with no `:` is ignored. |
| `autoRun` | `object` | Natural-language steering for the Auto-review **classifier**. Read only in Auto-review mode; no effect in Allowlist or Run Everything. |
| `autoRun.allow_instructions` | `string[]` | Sentences describing call shapes the classifier should lean toward allowing. |
| `autoRun.block_instructions` | `string[]` | Sentences describing call shapes it should lean toward blocking. |

**Locations and merge:** `~/.cursor/permissions.json` (per-user) and `<workspace>/.cursor/permissions.json` (per-repo). Both optional. "When both exist, Cursor **concatenates** the arrays inside every field." Re-read on change. **[OFFICIAL]**

**Precedence (strict, documented):** `team admin (dashboard) > permissions.json (per-user ∪ per-repo) > IDE settings UI`. **[OFFICIAL]**

- When `permissions.json` defines a key, that key **replaces** the IDE allowlist entirely — the in-app editor becomes read-only and "Add to allowlist" is hidden.
- A key present but resolving to an empty array → the effective allowlist is **empty**; Cursor does **not** fall back to the IDE list. A subtle fail-closed/fail-open trap.
- The three areas are independent: defining only `mcpAllowlist` leaves terminal and `autoRun` under IDE control.

### 2.3 Confirmed syntax examples

Deterministic allowlists — **[OFFICIAL]**:

```jsonc
{
  "mcpAllowlist": ["github:*", "linear:list_issues"],
  "terminalAllowlist": ["git", "npm", "yarn", "pnpm", "cargo", "make"]
}
```

Classifier steering — **[OFFICIAL]**:

```jsonc
{
  "autoRun": {
    "allow_instructions": [
      "Read-only inspections of build artifacts under ./dist are fine."
    ],
    "block_instructions": [
      "Especially for delete operations, I like for the classifier to reject so I can have a chance to review the operation."
    ]
  }
}
```

Two documented caveats on `autoRun`, verbatim: a call matching an `allow_instructions` entry "still goes through the safety check"; a call matching `block_instructions` "can still be approved when Cursor insists." And: "**Treat both as steering, not enforcement.**" The same page's note header reads: "**Not a security boundary.**" **[OFFICIAL]**

Cursor CLI permission tokens — **[OFFICIAL]**:

```json
{
  "permissions": {
    "allow": [
      "Shell(ls)", "Shell(git)", "Read(src/**/*.ts)", "Write(package.json)",
      "WebFetch(docs.github.com)", "Mcp(datadog:*)"
    ],
    "deny": ["Shell(rm)", "Read(.env*)", "Write(**/*.key)", "WebFetch(malicious-site.com)"]
  }
}
```

Documented CLI semantics: globs `**`/`*`/`?`; relative paths scoped to the workspace; **"Deny rules take precedence over allow rules"**; `command:args` (e.g. `curl:*`) matches command and arguments with globs. **[OFFICIAL]**

### 2.4 Run Modes — defaults and the classifier

Cursor 3.6 (May 29, 2026) shipped **Auto-review** as the recommended default. Cursor 3.5 (May 22, 2026) deprecated **Ask Every Time** ("Use **Allowlist** with an empty allowlist for the same behavior") and folded **Run in Sandbox** into **Allowlist** with sandboxing enabled. **[OFFICIAL]** — https://cursor.com/docs/agent/security/run-modes.md

| Mode | Runs without asking | Sandbox | Classifier |
| :-- | :-- | :-- | :-- |
| **Auto-review** | Allowlisted calls immediately; other shell commands sandboxed where possible; the rest → classifier | Yes, for shell | Yes |
| **Allowlist** | Actions in your allowlist | Optional | No |
| **Run Everything** | Every tool call | No | No |

Auto-review applies to **shell, MCP, and Fetch**. The classifier "returns allow, try-something-different, or ask-the-human" — when it blocks, "Cursor can try another approach"; if the agent still thinks the action makes sense, "Cursor will show you an approval prompt." **[OFFICIAL]**

**Classifier models:** "small Cursor-managed models. Today it uses Gemini 3.5 Flash Lite, with Claude 4.5 Haiku as the fallback." **[OFFICIAL]** — note the operational coupling: if the team blocks both models under model access control, Auto-review grays out and members fall back to Allowlist.

`permissions.json` only takes effect when a Run Mode is enabled. **[OFFICIAL]**

### 2.5 Protections that always prompt, and the sandbox

Three protections can require approval even when a mode would otherwise auto-run: **Browser Protection**, **File-Deletion Protection** (including `rm` commands), **External-File Protection** (create/modify/delete outside the workspace). **[OFFICIAL]**

Sandbox: Seatbelt (`sandbox-exec`) on macOS; Landlock + seccomp on Linux (kernel 6.2+ with `CONFIG_SECURITY_LANDLOCK=y`, unprivileged user namespaces); on Windows there is **no native boundary** — it uses the Linux sandbox inside WSL2. Network is **blocked by default**, then opened by network mode + `sandbox.json`. `/tmp` writable. Deny-write protected paths include `.git/config`, `.git/hooks`, `.vscode`, `.cursorignore`. If sandbox creation fails on Linux, "Cursor falls back to asking for approval before running commands." **[OFFICIAL]**

Default network allowlist is a long list of package-manager and language-tool domains — including `registry.npmjs.org`, `npmjs.com`, `npmjs.org`, `crates.io`, `pypi.org`, `files.pythonhosted.org`, `rubygems.org`, `github.com`, `*.githubusercontent.com`. **[OFFICIAL]**

Network mode options: **sandbox.json Only**, **sandbox.json + Defaults** (the default), **Allow All**. **[OFFICIAL]**

### 2.6 Hooks — the deterministic seam (and its fail-open default)

Hook config lives in `~/.cursor/hooks.json` (user) or project-level. Real shape **[OFFICIAL]**:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [{ "command": "./hooks/validate-tool.sh", "matcher": "Shell|Read|Write" }],
    "beforeShellExecution": [{ "command": "./script.sh" }],
    "beforeMCPExecution": [{ "command": "./script.sh" }],
    "beforeReadFile": [{ "command": "./redact.sh" }],
    "afterFileEdit": [{ "command": "./format.sh" }],
    "stop": [{ "command": "./audit.sh", "loop_limit": 10 }]
  }
}
```

`beforeShellExecution` / `beforeMCPExecution` output **[OFFICIAL]**:

```json
{
  "permission": "allow" | "deny" | "ask",
  "user_message": "<message shown in client>",
  "agent_message": "<message sent to agent>"
}
```

`beforeShellExecution` input: `{ command, cwd, sandbox }`. `beforeMCPExecution` input: `{ tool_name, tool_input, mcp_server_name, ... }`.

**The critical default — `failClosed` is `false`:** "Crashes, timeouts, and non-zero exit codes other than `2` fail open by default: Cursor logs the failure and allows the action through. Set `failClosed: true` on the hook definition to block on those failures too." Two nuances in the docs: (a) "Permission hooks block on invalid JSON or an invalid response even when this is `false`" — so a *malformed* response fails closed; (b) "Exit code 2 blocks, Claude Code-style."

Cursor's own enterprise doc declares the allowlist limit verbatim: "**The allowlist is best-effort, not a security boundary. Determined agents or prompt injection might bypass it. Always combine allowlists with other security controls like hooks.**" **[OFFICIAL]** — https://cursor.com/docs/enterprise/llm-safety-and-controls.md

### 2.7 Cloud agents

"Cloud Agents do not use Run Modes… Cloud Agents run inside their own dedicated machine, so the agent never asks you to approve an action." **[OFFICIAL]** A secondary source describes the boundary as VM isolation + egress allowlists + review-before-merge on a draft PR. **[SECONDARY]**

---

## 3. Cursor forum — what users actually complain about

Fetched as raw Discourse JSON.

### 3.1 "How does command allowlist/denylist really work?" (topic 102782, opened 2025-06-11, 13 posts) — https://forum.cursor.com/t/how-does-command-allowlist-denylist-really-work/102782

The thread is a running demonstration that the documented semantics did not match observed behaviour.

- Opening poster: `grep` is allowlisted but Cursor still asks permission for `grep -A 5 -B 5 "STEP DEBUG.*contract ID\|..." log/test_p5.log`. "**Simple wildcards or regexes would solve this.**"
- Reply: "It is not a simple exact match on the command name (executable). I've added `git` and it still ask about `git log ...` commands." (2025-06)
- 2025-07: "It's a safety-critical alternative for babysitting each action of the AI agent. It needs to be better specified. Even without malicious AI hijacks I've seen enough sudden AI meltdowns where it would go haywire and start randomly breaking things."
- 2026-01 testing report: (1) with empty allow and deny, **no commands are allowed**; (2) allow acts as a whitelist; (3) **deny takes priority over allow** — with a terminal log showing `{"permissions":{"allow":["Shell(ls)"],"deny":[]}}` and `pwd` rejected, `ls` accepted (that log is the **CLI** config, `cli-config.json`, not `permissions.json`).
- 2026-01: "the allow list matches the first part of the command. So `cd` will match any command beginning with `cd`. **`npm` will allow any and all `npm` commands, including `npm install`.**"
- 2026-02: "I explicitly need confirmation that the allowlist does not support subcommands. **Allowing `pnpm test` also allows `pnpm install` which seems like a MAJOR security issue.**"
- A community responder: "Right now the agent just uses prefix matching, so the best fix is to put dangerous subcommands like `pnpm install` right into the deny list. Since deny always overrides allow, it is really the only way to get granular control until we get official regex or exact-match support." — followed immediately by: **"What deny list? I don't see any deny list in the UI."**
- 2026-03: "We, most definitely, need regex for this. I can't let agent's just 'do work' on their own, **I have to sit here and babysit them sometimes a few times every minute to allow even simple things like builds.**"
- 2026-04: a user built a `beforeShellExecution` gating hook and reports: "I asked Cursor to escape/bypass it and it couldn't."

**Semantic conflict to flag:** the official reference says `git status` is narrower and matches "Only `git status` (and anything starting with `git status `)", which implies a narrower entry *should* exclude `pnpm install`. Multiple users report the opposite in practice for `pnpm test`/`pnpm install`. I could not resolve this from official docs; treat narrower-than-first-token entries as **unreliable** and rely on hooks for anything that must hold.

### 3.2 "Lack of denylist will bite someone sooner or later" (topic 124977, 2025-08-01, 8 posts) — https://forum.cursor.com/t/lack-of-denylist-will-bite-someone-sooner-or-later-give-users-control/124977

- OP: "The commands must go through a deny list first, then through an allow list. Match on deny list — immediate stop of a command. No match on either list — ask user!" and "I want to deny `*rm -rf*` in any piping command but I'm fine with single `rm`." Cursor staff replied "we'll consider it."
- 2026-03: a concrete **MCP-containment bypass** — "I started using the AWS MCP tool and it really only wrap calls around the AWS CLI… I explicitly gave a limited profile to the MCP for the Agent to use but when the Agent launches the AWS CLI directly it puts whatever it wants as a `--profile` switch, completely overpassing the MCP limitation. So, this morning I wanted to simply 'deny' Cursor the whole `aws` CLI command only to find out that… **I cannot. There is no Deny list anymore.**"
- 2026-04, the same pattern with Postgres: "I have an MCP for Postgres, and I set it up in read-only mode. Then I asked Cursor to try to delete a record… it attempted to work with the MCP, but due to the restriction, it failed. **Then it wrote a sql script, got my ENV variable for the DB and called `psql` directly, and that succeeded.**"
- Workaround: `beforeShellExecution` returning `{"permission": "deny"}` — "I asked Cursor to list the content of my directory using the `ls` command, and as the hook returned a 'deny' it failed; it couldn't do it. It tried to use Python, Node, and other runtimes to try to get the result, but it couldn't. After that, I asked it to escape the hook to find a way. It tried a bunch of stuff, but couldn't escape."
- One user's proposed resolution: adopt Claude Code syntax — `{"permissions": {"deny": ["Read(~/.aws/**)", "Bash(aws *)"]}}`.

### 3.3 "How are we supposed to prevent catastrophic mistakes?" (topic 158756, 2026-04-22, 8 posts) — https://forum.cursor.com/t/how-are-we-supposed-to-prevent-catastrophic-mistakes/158756

- OP (mid/large company rolling out Cursor across engineering *and operations*): worries about overwritten infrastructure changes, bad Excel transformations, production DB/K8s changes, `docker system prune`, deleting local files that matter. "How do you actually keep control of this in practice?"
- Cursor staff answer (2026-05) sorts controls into "deterministic security controls (hard gates)" vs "LLM steering (soft layer)": allowlist/denylist in Auto-Run, hooks (`beforeShellExecution` "blocks a command at the policy level, not at the prompt level, so the agent can't talk its way around it"), sandboxing/cloud agents; then rules as a soft layer, then enterprise governance. **Note this staff reply asserts a terminal "denylist" you "can explicitly put `rm -rf`, `docker system prune`, `kubectl delete`… on" — which contradicts both the official `permissions.json` reference (no deny key) and the users in topic 124977 who cannot find one.** Unresolved contradiction; do not design against that claim.
- Practitioner replies converge on **controlling the environment, not the agent**: "don't try to fully control the agent, control the environment around the agent"; protected `master`, mandatory human PR review, human review before production ops, backups on multiple drives, staging-only agent access. One: "The key mindset shift is: AI agents are becoming autonomous minions with terminal access, not just autocomplete. So the real solution is reducing blast radius instead of manually checking every tiny action."

### 3.4 Other relevant threads

- **"Allowlist is too easy to add to"** (124714) — the prompt UI offers to add just `python3` when you run `python3 Tools/economic_analysis.py`: "No one can allow `python3` to use freely." OP found `python3` in their allowlist without intentionally adding it. Requests: regex, args, per-command dialog, temporary allow ("allow for this question", "allow for the next hour").
- **"Allow Git Writes without Approval is BAD"** (150485) — staff confirms the toggle is binary: "Either git is fully read-only, or **everything is allowed without respecting your allowlist**."
- **"Allowlist is too easy to add to"**, **"Simplify command denylist/whitelist"** (118206), **"Huge fan of allowlist terminal (NOT sandbox!), however there is a need for a companion denylist"** (150231) all request the same thing: wildcards/regex, deny-before-allow order, and project-scoped rules.

---

## 4. Cline / Roo Code

### 4.1 Cline — model-judged approval, not an allowlist

Per-category Auto Approve, evaluated **per tool call** **[OFFICIAL]** — https://docs.cline.bot/features/auto-approve

| Setting | What it allows |
| :-- | :-- |
| Read project files | Read/list/search in your workspace |
| Read all files | Read outside workspace (**requires base toggle**) |
| Edit project files | Create and edit files in workspace |
| Edit all files | Edit outside workspace (**requires base toggle**) |
| Execute safe commands | Run terminal commands marked safe |
| Execute all commands | Run commands requiring approval (**requires base toggle**) |
| Use the browser | Web fetching and searching |
| Use MCP servers | MCP tools and resources |
| Enable notifications | Notify on long-running commands |

The key design fact, quoted verbatim: "**Cline does not use a fixed allowlist. The model marks each command with a `requires_approval` flag based on the command and arguments. These are examples, not guarantees.**" **[OFFICIAL]**

Examples given: safe ≈ `npm run build`, `npm test`, `git status`, `ls -la`, `cat package.json`; approval-required ≈ `npm install <pkg>`, `rm -rf <path>`, `mv <a> <b>`, `sed -i ...`. Note `npm install` is in the *requires approval* bucket by example — but by the doc's own wording that classification is probabilistic.

Documented safety guidance: enable only **Read project files** initially; "Leave edits, commands, browser, and MCP off until you have a specific reason"; if you enable edits, use **Checkpoints** so you can roll back.

**YOLO mode** auto-approves file changes, terminal commands, browser actions, MCP tools, **and mode transitions** (Plan→Act). Docs list what could go wrong (delete files, install/uninstall packages, commit and push). **Enterprise control:** remote configuration `{"yoloModeAllowed": false}` disables the toggle for all users and "cannot be overridden by individual users." Enterprise guidance recommends **disable at every org size** (small/medium/large).

**SDK fail-open default worth noting** **[OFFICIAL]** — https://docs.cline.bot/sdk/guides/permission-handling: "**Tool names not listed in `toolPolicies` default to enabled and auto-approved**, so set policies explicitly for tools that need review."

```ts
toolPolicies: {
  read_files: { autoApprove: true },
  write_file: { autoApprove: false },
  run_commands: { autoApprove: false },
  // { enabled: false } removes the tool from the model's view entirely
}
```

### 4.2 Roo Code — a real prefix allowlist with injection guard

**[OFFICIAL]** — https://docs.roocode.com/features/auto-approving-actions (page leads with a block-caps security warning that auto-approve "can result in data loss, file corruption, or worse").

Eight auto-approve tiles with published risk levels: Read files and directories (Medium), Edit files (**High**), Execute approved commands (**High**), Use the browser (Medium), Use MCP servers (Medium-High), Switch modes (Low), Create & complete subtasks (Low), Answer follow-up questions (Low).

Command auto-approval **is** allowlist-based, with a denylist:

```json
{
  "roo-cline.allowedCommands": ["git", "npm run", "echo"],
  "roo-cline.deniedCommands": ["git push", "npm publish", "rm", "sudo", "*"]
}
```

Documented semantics: "**Precedence: Deny rules take precedence when their matching prefix is equally or more specific than the allow match (longest-prefix wins).**" And: "With both lists defined, the longest-prefix rule applies; if deny is equally or more specific, it wins." `*` in the allow list allows all commands. Recommended production template: "Deny all with `*` then allow specific safe prefixes like `git`, `npm run`, `echo`."

Roo publishes a default high-risk deny list — Unix/macOS: `rm`, `sudo`, `dd`, `mkfs`, `diskutil eraseDisk`, `shutdown`, `reboot`, `chmod -R`, `chown -R`, `kill -9`, `curl | sh`, `wget | sh`; Git/package: `git push`, `npm publish`, `yarn publish`, `pnpm publish`; Windows/PowerShell: `Remove-Item`, `Format-Volume`, `Stop-Process`, `shutdown`, `Set-ExecutionPolicy`.

**Dangerous substitution guard** — the most directly relevant precedent for the design in question: "Even allowed prefixes won't auto-approve if the command contains dangerous parameter or process substitutions (e.g., `${var@P}`, subshells inserted into here-strings, zsh process substitution `=(...)`, zsh glob qualifiers with `e:...:`)." **[OFFICIAL]**

Other mechanisms: **write delay** after auto-writes (Settings → Context Management → Diagnostics; default 1000 ms, 2000 ms+ recommended for complex projects, 0 ms "use when speed is critical"); **workspace boundary protection** (outside-workspace reads/writes need extra flags); **protected files** (`.roo/`, `.rooignore`). Follow-up questions can auto-select the first suggestion after a 1–300 s timeout (default 60 s) — itself a fatigue mitigation.

---

## 5. Claude Code — the most specified model

Primary source: https://code.claude.com/docs/en/permissions and https://code.claude.com/docs/en/permission-modes. All **[OFFICIAL]**.

### 5.1 Modes and defaults

| Mode | What runs without asking | Best for |
| :-- | :-- | :-- |
| `default` (labeled **Manual**, alias `manual`) | Reads only | Reviewing every action yourself |
| `acceptEdits` | Reads, file edits, and common filesystem commands (`mkdir`, `touch`, `mv`, `cp`, …) | Iterating on code you're reviewing |
| `plan` | Reads, plus classifier-approved commands when auto mode is available | Exploring before changing |
| `auto` | Everything, with background safety checks | Long tasks, **reducing prompt fatigue** |
| `dontAsk` | Reads and pre-approved tools; anything that would prompt is **denied** | Locked-down CI and scripts |
| `bypassPermissions` | Everything | Isolated containers/VMs only |

**Default posture (important — differs from common assumption):** "With Claude Code v2.1.283 or later, **auto mode is the built-in starting permission mode** for interactive terminal and VS Code sessions. On earlier versions, it's the built-in starting permission mode only on Pro, Max, and Team plans." `claude -p` and the Agent SDK default to `default` in sessions that fetch feature flags. Auto mode requires a supported model (Sonnet 5+, Opus 4.7+, Fable models on cloud providers) or the session starts in Manual.

Anti-tampering detail: setting `defaultMode: "auto"` or `"bypassPermissions"` in `.claude/settings.json` or `.claude/settings.local.json` **does not take effect** (Claude Code ignores it and uses the built-in default / Manual instead). Only user, `--settings`, or managed settings can select those.

Admin kill switches: `permissions.disableBypassPermissionsMode` and `permissions.disableAutoMode` set to `"disable"`, "most useful in managed settings where they can't be overridden." `dontAsk` never appears in the Shift+Tab cycle.

### 5.2 Rule syntax and matching granularity

Format: `Tool` or `Tool(specifier)`. Parentheses inside the specifier are literal.

```json
{
  "permissions": {
    "allow": ["Bash(npm run *)", "Bash(git commit *)"],
    "deny": ["Bash(git push *)"]
  }
}
```

Documented matching semantics:

| You write | Matches | Doesn't match |
| :-- | :-- | :-- |
| `Bash(npm run build)` | `npm run build` | `npm run build --watch` |
| `Bash(npm run *)` | `npm run build`, `npm run test --watch`, `npm run` | `npm install` |
| `Bash(git log * main)` | `git log --oneline main`, `git log -5 main` | `git log main`, `git push origin main` |
| `Bash(git * main)` | `git merge main`, `git push origin main`, `git -c core.fsmonitor=<script> diff main` | `git log` |
| `Bash(ls *)` | `ls -la`, `ls` | `lsof` |
| `Bash(ls*)` | `ls -la`, `lsof` | — |
| `Bash(* --version)` | `node --version`, `bash -c 'echo hi' --version` | `node -v` |

Three rules produce those rows: a `*` stands in for whatever text is in its place; a trailing `*` with a space before it also matches the bare command (only when it's the rule's only wildcard); **the space before a trailing `*` is part of the rule** (`ls *` ≠ `ls*`). `Bash(ls:*)` ≡ `Bash(ls *)`; `:*` is recognized **only at the end**.

**Evaluation order: deny → ask → allow. The first match in that order wins, and rule specificity does NOT change the order.** A broad deny like `Bash(aws *)` blocks calls that also match a narrower allow like `Bash(aws s3 ls)`; "An allow rule can't carve an exception out of a deny rule." A bare tool name deny (`Bash`) removes the tool from Claude's context entirely so the model never sees it; a scoped rule (`Bash(rm *)`) leaves the tool available and blocks matching calls.

**Parameter rules** (`Tool(param:value)`) work for **deny and ask only**, e.g. `Agent(model:opus)`, `Agent(isolation:worktree)`, `Bash(run_in_background:true)`. Values support `*`. Crucially: "You can't match a tool's primary content field this way: `command` for Bash… A rule like `Bash(command:rm *)` would be bypassable by a compound command, so Claude Code ignores it and emits a startup warning."

**Tool-name globs:** deny/ask accept globs (`"*"`, `"mcp__*"`). Allow globs are only accepted after a literal `mcp__<server>__` prefix; "An unanchored allow glob such as `"*"`, `"B*"`, or `"mcp__*"` is skipped with a warning and does not auto-approve anything."

**Compound commands:** Cursor-parser-aware. Recognized separators: `&&`, `||`, `;`, `|`, `|&`, `&`, newlines. "**A rule must match each subcommand independently**" for *allow*. Deny and ask rules apply when *any* subcommand matches — "including a command nested inside a subshell, a command substitution, or a control-flow body such as a `for` loop." Approving a compound with "don't ask again" saves a separate rule per subcommand (up to 5).

**Wrappers stripped before matching:** `timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, zsh `noglob`, and bare `xargs`. Not stripped: the query form `command -v`, zsh `nocorrect`, and — critically — "**Development environment runners such as `direnv exec`, `devbox run`, `mise exec`, `npx`, and `docker exec` are not in the list.** Because these tools execute their arguments as a command, a rule like `Bash(devbox run *)` matches whatever comes after `run`, **including `devbox run rm -rf .`**." Exec wrappers `watch`, `setsid`, `ionice`, `flock` can't be prefix-approved at all, nor `find` with `-exec`/`-delete`. The wrapper list is built in and **not configurable**.

**Leading env assignments:** an *allow* rule matches past an assignment only of "certain known-safe environment variables" (`NODE_ENV=test npm test` matches `Bash(npm test *)`); "An allow rule won't match past an assignment of any other variable. A deny or ask rule matches past any leading assignment, so `Bash(rm *)` in deny still matches `FOO=bar rm -rf tmp/`."

### 5.3 Does it detect command substitution / injection?

Partly, and asymmetrically — this is worth copying.

- **Deny and ask rules look inside nested constructs.** "Deny and ask rules apply when any subcommand matches them, including a command nested inside a subshell, a command substitution, or a control-flow body such as a `for` loop. An ask rule like `Bash(git clean *)` still prompts you for `cd /tmp && git clean -f` or `echo "$(git clean -f)"`, even in auto mode."
- **The hook `if` matcher documents the same behaviour:** `Bash(rm *)` vs `echo $(rm -rf /)` → hook runs ("commands inside `$()` and backticks are checked"); `Bash(rm *)` vs `echo $(date)` → does not run. And a conservative fallback: "patterns that specify more than the command name run the hook anyway on `$()`, backticks, or `$VAR`." **[OFFICIAL]** — https://code.claude.com/docs/en/hooks
- **Allow rules do not get tricked into covering a substitution**, because they must match each subcommand independently — so `Bash(safe-cmd *)` "won't give it permission to run the command `safe-cmd && other-cmd`."

**But the docs explicitly deny that Bash rules are a boundary around a program:**

| Rule | Stops | Doesn't stop |
| :-- | :-- | :-- |
| `Bash(curl *)` | `curl https://example.com` | `/usr/bin/curl …`, `sh -c 'curl …'` |
| `Bash(rm *)` | `rm -rf build/` | `/bin/rm -rf build/`, `bash -c 'rm -rf build/'` |
| `Bash(git push *)` | `git push origin main` | `git -C . push origin main`, `git -c push.default=current push origin main`, `git 'push' origin main` |

Verbatim: "a deny or ask rule covers the invocation Claude usually produces and **isn't a security boundary around the program**." The prescribed fix for anything that must hold: sandboxing, or a PreToolUse hook.

There is also a documented fragility warning on rules that try to constrain arguments (`Bash(curl http://github.com/ *)` misses `curl -X GET …`, `https://`, redirects, and `URL=… && curl $URL`), with the recommendation to deny `curl`/`wget` and use `WebFetch(domain:…)` plus the sandbox network allowlist instead.

### 5.4 Fail-closed behaviour

- Claude Code's security page states it as a design principle: "**Fail-closed matching: In Manual mode, unmatched commands require approval by default.**"
- **Unparseable input prompts rather than being treated as safe:** "when Claude Code can't fully parse a command, it asks for approval instead of treating the command as read-only. Commands longer than 10,000 characters always prompt." And `npm test &&` (dangling operator) is treated as unparseable so `Bash(npm *)` doesn't approve it.
- **Classifier no-verdict ⇒ deny, not allow:** "**The server gives no verdict for an action**: Claude Code denies the action rather than run it unreviewed." Same on a parse failure — "when a safety check separate from auto mode refuses the classifier's own request, or the classifier's response doesn't parse, Claude Code denies the action."
- `dontAsk` mode denies anything that would prompt.
- The hook layer is the opposite default, though: a PreToolUse hook that crashes does not grant permission, but a hook returning `"allow"` "doesn't override a matching deny rule," and a hook exiting 2 "stops the tool call before permission rules are evaluated, so the block applies even when an allow rule would otherwise let the call proceed."

### 5.5 Structural circuit breakers (mode-independent)

Two independent concepts no mode can bypass:

**Protected paths** — never auto-approved except in `bypassPermissions` (and interactive plan sessions with bypass available). Directories: `.git`, `.config/git`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`, `.claude` (except `.claude/worktrees`). Files include `.gitconfig`, `.gitmodules`, `.bashrc`/`.zshrc`/`.profile`/`.envrc`, `.npmrc`/`.yarnrc`/`.pnp.cjs`/`bunfig.toml`, `.bazelrc`, `.pre-commit-config.yaml`/`lefthook.yml`, `gradle-wrapper.properties`, `.devcontainer.json`, `.ripgreprc`, `pyrightconfig.json`, `.mcp.json`, `.claude.json`. Per-mode outcome: `default`/`acceptEdits` → prompt; `auto` → classifier; `dontAsk` → deny; `bypassPermissions` → allow. **"`permissions.allow` rules in settings files do not pre-approve protected-path writes"** — the safety check runs before allow rules are evaluated, so `Edit(.claude/**)` in user settings changes nothing.

**Critical paths** — `rm`/`rmdir` targets that are the filesystem root, top-level dirs (`/usr`, `/etc`, `/data`), the home directory, the working directory and its parents, plus a documented set of variable/substitution forms (`rm -rf "$DIR"/*`, `rm -rf "$1"/*`, `rm -rf "$TMPDIR/mnt"`, `D=$(pwd); rm -rf "$D"`, `rm -rf "$(pwd)"`, `rm -rf ~/$(cmd)`, a lone `\\`). "**Claude Code never lets a `permissions.allow` rule or a `PreToolUse` hook that returns `"allow"` approve an `rm` or `rmdir` command that targets a critical path, even in modes that skip other prompts.** This circuit breaker guards against model error." It also looks inside `(...)`, `{ ...; }`, `$(...)`, backticks, `<(...)`, and scripts passed to `sh -c`/`bash -c`.

Handling in the permissive modes: `auto` and `bypassPermissions` show a **two-minute countdown** prompt; after 3 unanswered prompts in a session, further critical-path removals are denied immediately; where no terminal prompt is possible (`-p`, Agent SDK, VS Code chat panel, Desktop app) Claude Code **denies immediately**. `dontAsk` denies. Opt-outs exist (`CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT=1`, `CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT=1`).

**Actions no mode auto-approves** (even `bypassPermissions`): tools matched by an explicit ask rule; org-`ask` connector tools; `AskUserQuestion` and MCP tools marked `requiresUserInteraction`; critical-path `rm`/`rmdir`; the cross-session messaging safeguards; reads outside working directories while `permissions.blockReadsOutsideWorkingDirectories` is on.

### 5.6 Auto mode's classifier — the anti-fatigue layer

- **Broad code-execution allow rules are dropped on entering auto mode:** blanket `Bash(*)`/`PowerShell(*)`, wildcarded interpreters like `Bash(python*)`, package-manager run commands, `Agent` allow rules, and `Monitor` allow rules. Narrow rules like `Bash(npm test)` stay. **"Claude Code restores the dropped rules when you leave auto mode."**
- `autoMode.classifyAllShell: true` suspends **every** shell allow rule for the session so the classifier sees every command. Documented motivation, verbatim: "When it skips, **a destructive argument the rule's prefix didn't anticipate can get through unseen.**"
- `autoMode.soft_deny`/`hard_deny`/`environment` accept prose rules, with `"$defaults"` to keep the built-ins. `claude auto-mode defaults` prints the full rule lists as JSON.
- **Classifier input hygiene:** "Tool results are stripped from those requests, so hostile content in a file or web page can't manipulate the classifier directly." A separate server-side probe scans incoming tool results for suspicious content before Claude reads them. A PostToolUse hook can add `classifierContext`.
- **Conversation-stated boundaries are treated as block signals** ("if you tell Claude 'don't push'… the classifier blocks matching actions even when the default rules would allow them") — but they are **not** stored as rules: "the classifier re-reads them from the transcript on each check, so a boundary can be lost if context compaction removes the message that stated it. For a hard guarantee, add a deny rule instead."
- **Approval wording matters:** naming the action and its specifics clears a block ("Naming the verb alone clears nothing, so 'you can force-push' leaves the block in place"); one approval covers one action unless granted as standing.
- **Repeated-block thresholds:** "if the classifier blocks an action 3 times in a row or 20 times total, **auto mode pauses and Claude Code resumes prompting.** Approving the prompted action resumes auto mode." Thresholds are documented as **not configurable**.
- Full blocked/allowed defaults are published in the docs. Blocked by default includes `curl | bash`, force push, `git reset --hard`/`clean -fd`/`stash drop`, `terraform destroy` and friends, unapproved PR merges, production feature-flag changes, `--insecure`-style guard disarming, and launching an agent loop with `--dangerously-skip-permissions`. **Allowed by default includes "Installing dependencies declared in your lock files or manifests"** and "Reading `.env` and sending credentials to their matching API."

### 5.7 Settings surface

Keys under `permissions`: `allow`, `ask`, `deny`, `additionalDirectories`, `blockReadsOutsideWorkingDirectories`, `defaultMode`, `disableBypassPermissionsMode`, `disableAutoMode`. Top-level `allowManagedPermissionRulesOnly: true` makes managed settings the only source of permission rules. Settings precedence: managed highest; "If a tool is denied at any level, no other level can allow it"; "deny rules from any scope are evaluated before allow rules."

**Project allow rules and workspace trust:** `permissions.allow` and `additionalDirectories` from a project's `.claude/settings.json` apply only after you accept the workspace trust dialog; `deny`/`ask` rules aren't gated because "they only restrict." `claude -p` and SDK sessions never show the dialog, so project allow rules are simply **not used** there.

Sandbox interaction: with sandboxing on and `autoAllowBashIfSandboxed` at its default `true`, sandboxed Bash commands run without prompting even under a bare `Bash` ask rule — "the sandbox boundary substitutes for that whole-tool prompt." Content-scoped ask rules like `Bash(git push *)` still force a prompt, and critical-path `rm`/`rmdir` still goes through the regular flow.

---

## 6. Aider — no permission model; git is the control

Verified against Aider's official options reference, FAQ, Git integration page, and scripting page. **No allowlist, denylist, sandbox, classifier, per-tool approval, or approval prompt for shell commands appears in any of them.** **[OFFICIAL — by absence]**

What exists instead:

- **`--yes-always`** (env `AIDER_YES_ALWAYS`): "Always say yes to every confirmation." **[OFFICIAL]** — https://aider.chat/docs/config/options.html
- **Git as the safety net:** "Whenever aider edits a file, it commits those changes with a descriptive commit message. This makes it easy to undo or review aider's changes." `/undo` "will undo and discard the last change." `--no-auto-commits` "will stop aider from git committing each of its changes." **[OFFICIAL]** — https://aider.chat/docs/git.html
- Aider's own FAQ's only shell-related guidance I found is using `/run git diff HEAD~1` to review recent changes.

So the answer to the question as posed is: **Aider has no permission layer; it relies on git auto-commits plus review of the diff**, and `--yes-always` is the only confirmation-related switch (it suppresses confirmations rather than adding them). I found no official Aider statement framing this as a deliberate security posture, so the framing "relies on git for safety" is my characterisation from the documented mechanisms, not a quoted design goal. Secondary hardening guides describe it the same way. **[SECONDARY]**

---

## 7. Confirmation fatigue — documented discussion

This is the least "documented" area: the strongest evidence is vendor blogs and forum threads, not spec text.

**Claude Code** names it and ships a mitigation — **[OFFICIAL]**, https://code.claude.com/docs/en/security:
> "**Prompt fatigue mitigation**: Support for allowlisting frequently used safe commands per-user, per-codebase, or per-organization."

The `auto` mode row in the permission-mode table lists its purpose as "Long tasks, **reducing prompt fatigue**."

**Cursor** states the failure mode explicitly in its Auto-review announcement — **[OFFICIAL]**, https://cursor.com/blog/agent-autonomy-auto-review:
> "**After enough repeated prompts, people stop reading carefully, and the approval flow becomes less meaningful.**"
> "We did not want the classifier to become another approval prompt generator."

Published numbers from that post: the classifier "currently blocks around **4%** of actions, though a block does not immediately become a user prompt"; "globally we're seeing that only about **7%** of total chats in Auto-review mode lead to at least one interruption"; "some enterprise customers we're working with previously saw roughly **40%** of actions blocked within their organization."

**Cursor forums** give the practitioner version:
- "I have to sit here and babysit them sometimes a few times every minute to allow even simple things like builds." (topic 102782)
- The allowlist accretes dangerously because it's easier to approve than to configure — the "**Allowlist is too easy to add to**" thread (124714), where `python3` appeared in the list unrequested.
- Requested mitigation patterns: temporary/scoped grants ("allow for this question", "allow in this workspace", "allow for the next hour"); regex/wildcard granularity so you can approve the *class* of safe command rather than each invocation.

**Mitigation designs actually shipped**, for reference:
| Mitigation | Product |
| :-- | :-- |
| Classifier replaces prompts for the non-obvious cases, with published interruption rates | Cursor Auto-review; Claude Code `auto` |
| Auto-approve *read-only* by default, prompt on write | Cline recommendation; Roo tile design; Claude Code read-only command set |
| Sandbox substitutes for the whole-tool prompt | Claude Code `autoAllowBashIfSandboxed` |
| Deny-before-allow with a published default high-risk deny list | Roo Code |
| Pause auto-approval and resume prompting after repeated blocks (3-in-a-row / 20-total) | Claude Code auto mode |
| Force a human checkpoint only for irreversible/critical targets (critical paths, protected paths) | Claude Code |
| OS notification when approval is needed, and when an auto-approved command has been running 30 s | Cline |
| Auto-select the default answer to follow-up questions after a timeout | Roo Code |
| Deterministic hook seam for the rules that must hold, so they don't need a prompt | Cursor `beforeShellExecution`/`beforeMCPExecution`, Claude Code PreToolUse |

---

## 8. Documented weaknesses and bypasses

**Verified CVEs (fetched from OpenCVE records).**

| CVE | Affects | Mechanism | Fixed | Score |
| :-- | :-- | :-- | :-- | :-- |
| [CVE-2025-54131](https://app.opencve.io/cve/CVE-2025-54131) | Cursor < 1.3 | "an attacker can bypass the allow list in auto-run mode with a backtick (`` ` ``) or `$(cmd)`" — arbitrary execution outside the allowlist without approval; triggerable via indirect prompt injection | 1.3 | 6.4 Medium |
| [CVE-2026-22708](https://app.opencve.io/cve/CVE-2026-22708) | Cursor < 2.3 | In Auto-Run with Allowlist, "certain shell built-ins can still be executed without appearing in the allowlist"; attacker poisons the shell environment, changing variables that "influence trusted commands" | 2.3 | 7.2 High |
| [CVE-2026-31854](https://app.opencve.io/cve/CVE-2026-31854) | Cursor < 2.0 | Malicious instructions on a visited website + a command-whitelist bypass → commands executed automatically | 2.0 | 8.7 High |

All three are the same class: **prefix/string-matched allowlists are bypassable by command substitution, environment poisoning, and prompt injection chained to either.** Cursor's own docs now say the allowlist "is best-effort, not a security boundary."

**`npm install` / lifecycle scripts.** Two independent documented exposures:
- Cursor's default terminal allowlist example in its own docs is `["git","npm","yarn","pnpm","cargo","make"]`, and its documented semantic for `npm` is prefix match — so `npm install`, `npm publish`, and anything a `postinstall` script runs are covered by that one entry. Cursor's default sandbox network allowlist also includes `registry.npmjs.org`, `npmjs.com`, `pypi.org`, `crates.io`, `rubygems.org`, so a sandboxed install can fetch. **[OFFICIAL]**
- Claude Code's auto-mode classifier **allows by default**: "Installing dependencies declared in your lock files or manifests." A lockfile-declared dependency's install scripts are therefore classifier-allowed by default. **[OFFICIAL]**
- By contrast, Cline's *examples* place `npm install <pkg>` in the requires-approval bucket and Roo's recommended default deny list includes `npm publish` — but Roo's list does not include `npm install`, and Cline's bucket is model-judged. **[OFFICIAL]**

**Invocation-form escapes.**
- Claude Code documents that `Bash(rm *)` does not stop `/bin/rm`, `bash -c 'rm -rf build/'`; `Bash(git push *)` does not stop `git -C . push`, `git -c push.default=current push`, or `git 'push'`. **[OFFICIAL]**
- Environment runners escape inner-command rules: `Bash(devbox run *)` matches `devbox run rm -rf .`; `npx`, `docker exec`, `direnv exec`, `mise exec` are explicitly **not** stripped. **[OFFICIAL]**
- Arguments-constraining rules are fragile: `Bash(curl http://github.com/ *)` misses `-X GET`, `https://`, redirects, and `URL=… && curl $URL`. **[OFFICIAL]**

**Fail-open defaults.**
- Cursor hooks: `failClosed` defaults to `false`; crashes, timeouts, and non-zero exits other than 2 "**fail open by default**." Cursor calls this out and recommends `failClosed: true` for security-critical `beforeMCPExecution`.
- Cline SDK: tools not listed in `toolPolicies` "**default to enabled and auto-approved**."
- Claude Code classifier: a missing verdict is denied — the only one of the four that fails closed on a classifier/protocol failure.

**Probabilistic enforcement.**
- Cursor `autoRun.allow_instructions`/`block_instructions` are natural-language steering by Cursor's own admission; a blocked call "can still be approved when Cursor insists."
- Cline's safe/unsafe command split is a model-generated `requires_approval` flag — "These are examples, not guarantees."
- Claude Code's classifier is a model: the docs warn it "can make mistakes" and that environment details must be configured for it to judge correctly.

**MCP→CLI containment break (community-reported, with two independent instances).** Where a tool was deliberately restricted via MCP (read-only Postgres; scoped AWS profile), the agent bypassed the restriction by invoking `psql` / `aws` directly in the shell with its own arguments and environment-variable credentials. In both cases the user found there was no denylist available to block the CLI. **[SECONDARY — Cursor forum, first-hand reports, not reproduced]** Mitigation reported as effective: a `beforeShellExecution` deny hook, which the reporting user says Cursor could not talk its way around even when asked to try.

**Longest-prefix subtlety.** Roo's precedence rule means a deny entry only wins if it is "equally or more specific" than the allow entry. A short deny prefix can therefore lose to a longer allow prefix — a trap if you assume deny always wins. (Cursor's CLI and Claude Code both state plain deny-wins, by contrast.)

**Startup-warning-as-safety-net.** Claude Code catches several classes of mistake with startup warnings rather than rejections — a bad wildcard position (`Bash(git * main)`), an unanchored allow glob, a rule naming an unknown tool, and a rule on a field Claude Code never consults (`Bash(command:…)`, `Write(path)`, `Glob(path)`). In several of those cases the rule is accepted and simply **ignored**, which is a silent-failure mode worth designing against. **[OFFICIAL]**

---

## 9. What I could NOT verify

1. **Cursor `sandbox.json` full schema.** The reference URL returned HTTP 500 on two attempts. I have only the summary in the Run Modes page (network mode, extra readable/writable paths, temp dirs, shared build caches). Do not design against a field list for this file.
2. **Whether Cursor's IDE agent has any deterministic deny mechanism.** The official `permissions.json` reference lists exactly three top-level keys and no deny array; the CLI reference does list `deny`. Multiple forum users (2026-03, 2026-04) state there is no deny list in the UI. But a Cursor staff reply (2026-05, topic 158756) describes putting `rm -rf`/`kubectl delete` "on the denylist," and another staff reply (2025-08) says "we'll consider it." **Contradiction unresolved.** Design conclusion: treat Cursor's only reliable deny seam as a `beforeShellExecution` hook with `failClosed: true`.
3. **Cursor `terminalAllowlist` granularity below the first token.** Official docs say `git status` is narrower ("Only `git status`"). Multiple independent forum users report the opposite for `pnpm test` vs `pnpm install`. **Unresolved** — and it matters, because it decides whether list entries are prefixes or subcommand-aware patterns. I could not test it myself.
4. **The "84% fewer approval prompts" figure.** I found it only in a third-party summary headline, not in the official Cursor post. What the official post says is ~4% of actions blocked and ~7% of Auto-review chats seeing ≥1 interruption. **Attribute the 84% figure to a secondary source only, if at all.**
5. **Cursor audit logging.** No native per-tool-call audit log on any tier is asserted by a secondary source (agenticcontrolplane.com), and I found no official Cursor page documenting one either — but absence in the pages I read is not proof of absence. The official enterprise doc's own answer is to build an audit trail with hooks (`afterShellExecution`, `afterMCPExecution` inputs include full command/output), which is consistent with there being no built-in log. **[SECONDARY / partially verified]**
6. **`agenticcontrolplane.com/controls/cursor` is a vendor's marketing-adjacent docs site, not Cursor.** I used it only to locate the official doc paths. Its substantive claims (schema, precedence, CVE list, Windows-has-no-native-sandbox, `failClosed` default) I then **independently confirmed** against `cursor.com/docs`, except the audit-log claim (item 5) and the Windows sandbox claim, which appear in the official docs as "on Windows, the Linux sandbox inside WSL2 — no native Windows boundary" in the secondary source only; the official Run Modes page simply omits a Windows section, which is suggestive but not conclusive.
7. **Cline's `requires_approval` heuristic.** The flag's existence and routing are official; the actual classification logic or a command list is not documented, so I cannot say whether `npm install` of a lockfile-declared dep is treated as safe.
8. **Aider's absence of a permission model** is an argument from absence across its options reference, FAQ, Git integration, and scripting docs. No official Aider page states "Aider has no permission model," and a shell-execution approval feature could exist in an area of the docs I did not read.
9. **Forum thread completeness.** I fetched raw Discourse JSON. Topic 102782 reports `posts_count: 13` but only some posts were present in the payload (posts 5, 11–13 missing), and topic 158756 reports 8 posts with numbers 1, 3, 4, 10, 11, 13, 14, 16–17 — i.e. deleted/merged posts. Quotations are from posts I actually retrieved.
10. **Confirmation-fatigue "literature."** Searches for the phrase surfaced mostly low-quality or proxied sources (`moltq.chat` Q&A pages, an `ezproxy`-mirrored arXiv link). I did not use them. The citable, verifiable discussion is the Cursor Auto-review announcement plus the two forum threads and Claude Code's named "prompt fatigue mitigation."
11. **Run Mode dates reflect the docs as published.** The official changelog dates Auto-review at Cursor **3.6, May 29, 2026** and the deprecations at **3.5, May 22, 2026**; Claude Code's `auto`-as-default threshold is **v2.1.283**, with many behaviours gated on individual patch versions. Re-confirm upstream before relying on any of these.
