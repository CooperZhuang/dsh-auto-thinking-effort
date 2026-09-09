# 交接文档 — dsh-auto-thinking-effort

> **给接手的人（或下一个会话的 agent）**：本文件是自包含的。你不需要之前的对话记录。
> 最后更新：2026-09-09。`pnpm check` 全绿（62 测试），真机验证见 §5。

---

## 0. 一句话现状

插件**已实现、已单测、已真机验证、已装进本机 `headless` profile**。
`v0.0.1`，未发布到 npm。代码提交：`feat: per-turn reasoning-effort selection for DSH`。

已真机确认：挂载与配置合并、客套消息 → `off`、对照组（关插件）→ `high`、明确要求深想 → `max`、
**Web GUI 里一轮 → `off`（覆盖了 settings 的默认 `high`，且该 profile 装有 `installModelSelection`）**。

未真机确认：同会话跨轮切换、真实子代理跳过、非 DeepSeek provider 的钳制（见 §5 表格）。

---

## 1. 这个项目要做什么

DSH 插件：**根据用户这一轮的提问自动选择模型的思考档位**。

流程：`agent/pre-step` 读用户消息 → 纯启发式打分 → 分数选档位 → 档位映射到 effort →
`agent/request` 里只改写 `reasoningEffort`（钳制到模型声明的档位）。

**不做什么**：不调模型分类、不改模型/provider/prompt、不管子代理（默认）、不碰 compaction 与
会话标题请求。

---

## 2. 仓库与环境事实

| 项 | 值 |
|---|---|
| GitHub | https://github.com/CooperZhuang/dsh-auto-thinking-effort （public） |
| 本地 | `C:\CodeRepository\dsh-auto-thinking-effort` |
| 分支 / 提交 | `main` / 见 `git log` |
| 包名 / 版本 | `dsh-auto-thinking-effort` / `0.0.1`（**未发布**） |
| Node / pnpm | v24.16.0 / 12.3.4（`packageManager` 已钉） |
| DSH 依赖 | **`0.1.2-rc.1`**（npm `next` dist-tag，不是 `latest`） |
| DSH CLI | `C:\Users\Cooper\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` |
| DSH 包源码 | 同目录 `node_modules\@deepseek-ai\` |
| 本机验证 profile | `C:\Users\Cooper\.dsh\profiles\headless`（bundles: `dsh-base`, `dsh-headless`, **`dsh-auto-thinking-effort`**） |
| 用户设置 | `C:\Users\Cooper\.dsh\settings.yaml`（`agent-default-model.reasoningEffort: high`） |
| 会话日志 | `C:\Users\Cooper\.dsh\sessions\--C-CodeRepository-dsh-auto-thinking-effort--\session-<id>\session.jsonl.zstd` |

---

## 3. 代码地图

| 文件 | 内容 |
|---|---|
| `src/config.ts` | schemastery schema + `resolveConfig`（输入可省略）+ `prepareConfig`（校验 + 编译规则 + 解析 `$strongest`/`$weakest`） |
| `src/levels.ts` | `DEFAULT_LEVELS` 分数带、`assertLevels`、`levelForScore`、`effortLadder`、`resolveEffort`（钳制） |
| `src/signals.ts` | `BUILTIN_RULES`（pin + 加权，中英双语）、`compileRules`（拒绝 `g`/`y`） |
| `src/classify.ts` | `classify`（pin → 加权 → 结构特征 → 分数带 → 裸接续继承）、`truncateForClassification`（头 60% + 尾 40%） |
| `src/state.ts` | `AgentState`：轮状态、steering 只升不降、`forTurn` 只认同一轮 |
| `src/index.ts` | 接线：`agent/pre-step`（只读）、`agent/request`（`prepend: true` 改写）、能力缓存、一次性告警 |
| `scripts/inspect-session.mjs` | 逐帧解 `session.jsonl.zstd` 并打印关键事件（**多帧！**） |

---

## 4. 关键 DSH API（含证据位置）

| 用途 | API / 事实 | 位置 |
|---|---|---|
| 请求改写缝 | `agent/request` waterfall，`await next()` 得到 loop 的 seed config，返回替换值 | `dsh-agent/lib/types/runtime-types.d.ts:246-263` |
| 读用户消息 | `agent/pre-step` 的 `payload.messages`，只取 `source.kind === 'user'` | `dsh-agent/lib/types/runtime-types.d.ts:228-245`；`dsh-llm/lib/types/message.d.ts:94-104` |
| waterfall 顺序 | 最外层监听器的返回值 = 最终值；`prepend` → `unshift` → 最外层 | `cordis/src/events.ts:225-243,254-260` |
| 会被谁盖掉 | `installModelSelection` 在 agent ctx 上重设 provider/model/effort | `dsh-agent/lib/types/model-selection.js:33-47` |
| 谁装它 | `session-controller` 行 → `dsh-api-session-controller` | `dsh-web-app/cordis.patch.yml`；`dsh-api-session-controller/lib/types/agent.d.ts:96-116` |
| 模型能力 | `await ctx.llm.resolveModelInfo(provider, model)` → `.reasoning.efforts[].id` | `dsh-llm/lib/types/index.d.ts:343`；`types.d.ts:279-306` |
| 不支持的 effort 会被拒 | `prepareCall` 不做钳制/别名 | `dsh-llm/lib/types/index.d.ts:347-357` |
| 请求头记账 | config 变了才追加 `request/header`（reason=change） | `dsh-agent-loop/lib/index.js:733-755` |
| effort 字段 | `LlmCallConfig.reasoningEffort?: ReasoningEffortId` | `dsh-llm/lib/types/call-config.d.ts:16-23`；`brand.d.ts:41-47` |
| 子代理标记 | `session.header.origin === 'subagent'` | `dsh-session/lib/types/types.d.ts:79-83` |
| 插件行如何挂载 | `dsh.bundle.patch` → `cordis.patch.yml`，`dsh plugin add` 后 reconcile 进 `dsh.profile.bundles` | `dsh/lib/plugin-F7ZVfRyo.js:46-78` |

---

## 5. 验证状态（诚实版）

**真机验证**（Node v24.16.0 / DSH 0.1.2-rc.1 / `deepseek-official`）：

| 场景 | 做法 | 结果 | 证据 |
|---|---|---|---|
| 挂载 + 配置合并 | `dsh plugin --profile headless add <path>` → `--dump-config` | 行与 config 正确 | `dsh --profile headless --dump-config` |
| 真机一轮（客套） | `dsh --profile headless "谢谢"` | `reasoningEffort: "off"` | `session-8ad972fc` |
| **对照组**（关插件） | 同句 + `--patch` 覆盖 `enabled: false` | `reasoningEffort: "high"` | `session-5d10f7f5` |
| 真机一轮（要求深想） | `dsh --profile headless "深入思考一下：…"` | `reasoningEffort: "max"` | `session-779daed0` |
| 真机一轮（因果分析，未 pin） | `dsh --profile headless "Why does the upload helper return undefined after the migration?"` | `reasoningEffort: "high"`（why +5、migration +4 = 9） | `session-30b39b2a` |
| **GUI 真机一轮** | 临时 `web-verify` profile（base+web-app+本插件）跑在 `127.0.0.1:5227`，浏览器发"谢谢" | `reasoningEffort: "off"`（settings 默认是 `high`，且该 profile 装 `installModelSelection`） | `session-76a1f832` |

**只在进程内验证**（`tests/wiring.spec.ts`：真 cordis Context + 真 `installModelSelection` + 真 waterfall，且**故意先注册 selection**）：

- 覆盖存储档位（第一个用例，去掉 `prepend` 就挂）
- 钳制 / 查不到能力 / 无共享档位
- 轮内 steering 只升不降、裸接续继承、跨轮不串档

**未真机验证（已知缺口）**：

- 同一会话内跨轮切换（turn1 `max` → turn2 `off`，产生 reason=change 的 `request/header`）
- 真实子代理会话被跳过（`applyToSubagents: false`）
- 非 DeepSeek provider 的钳制路径

复现：

```powershell
node scripts\inspect-session.mjs "C:\Users\Cooper\.dsh\sessions\--C-CodeRepository-dsh-auto-thinking-effort--\session-8ad972fc-e503-4fde-b78a-73c4264c1c8f"
node scripts\inspect-session.mjs <session-dir> --grep "request/header"
```

---

## 6. 陷阱清单（都是踩过的）

1. **`@deepseek-ai/dsh-*` 的 npm `latest` 是旧的 `0.0.1-rc.x`**；正确版本在 `next` = `0.1.2-rc.1`。装依赖必须钉版本。
2. **schemastery 的 `.default()` 参数必须能赋给 schema 的**输出**类型**：`levels` 里 `maxScore` 用 `z.number().required(false)` 时，输出类型仍是 `number`，所以默认值不能是"缺字段的对象数组"——改成 `.default([])`，把"空 = 默认阶梯"交给 `prepareConfig` 处理。
3. **`Config` 是"可调用 schema"**（`Config(raw)`），没有 `.parse`；输入类型被声明成输出类型，传部分对象要经过 `resolveConfig` 这一层。
4. **`session.jsonl.zstd` 是多帧 zstd**（每个 flush 一帧）：`zstdDecompressSync` 读整文件只解第一帧，看起来"只有一个事件"。用 `scripts/inspect-session.mjs`（逐帧扫描后逐帧解）。
5. **`ctx.llm.resolveModelInfo()` 是 async**，且失败/未挂 llm 都要降级成"不改请求"。
6. **`playwright-cli` 的 `default` 浏览器是跨会话共享的**：另一个 agent 会话（或用户）已经打开过它时，`open <url>` 可能"成功"但当前页面属于**另一个** `dsh web` 服务器。2026-09-09 就发生过：往 5227 的验证服务器发消息，结果消息进了 18081 上另一个会话的服务器。**动手前必须确认页面 URL / 端口**（或 `Get-NetTCPConnection -LocalPort <port>`）。也不要 `close` 共享浏览器。
7. **headless 是一次性任务**（`dsh --profile headless "任务"` 答完即退），没有多轮入口；`dsh web` 才有会话与多轮，但会起服务器（默认 3080 可能已被占用，用 `--port 0`）。
8. **`dsh plugin --profile <name> add <相对路径>`** 会以 profile 目录为基准解析，必须传**绝对路径**（或让 `anchorPathSpec` 处理 `.`/`..`）。
9. **自定义 profile 名只会初始化成 `[dsh-base]`**：要 web 行为得手动把 `@deepseek-ai/dsh-web-app` 加进 `dsh.profile.bundles`（in-box bundle 从全局安装解析，不需要作为依赖装）。

---

## 7. 下一步（按优先级）

1. **U1 真机多轮验证**：临时 `web-verify` profile（base + web-app + 本插件，`--port 0`），浏览器里同一会话连发两条（先"深入思考…"再"谢谢"），确认两条 `request/header`（第二条 reason=change）。⚠️ 先读 §6 陷阱 6。
2. **U2 真实子代理**：跑一次 `subagent` 调用，确认子会话的 `request/header` 未被改写；再开 `applyToSubagents: true` 对比。
3. **发布**：`pnpm publish`（`prepublishOnly` 会构建）+ 在 `dsh-context-window` 的 README 风格下补一段"与其他插件共存"的说明。
4. **U3 非 DeepSeek provider**：接一个声明 3 档或 5 档的 provider，验证钳制。
5. 可选：给 GUI 加一个"本轮档位"的只读显示（需要 client 插件，目前是 host 单半）。

---

## 8. 命令速查

```powershell
# 开发门禁（= CI）
cd C:\CodeRepository\dsh-auto-thinking-effort
pnpm install ; pnpm check      # typecheck → lint → build → test

# 看 DSH 源码（只读）
#   实现： C:\Users\Cooper\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<pkg>\
#   组合： dsh-base\cordis.patch.yml、dsh-web-app\cordis.patch.yml、dsh-agent-presets\presets\standard\agent.cordis.yml

# 挂载 / 卸载
dsh plugin --profile headless add C:\CodeRepository\dsh-auto-thinking-effort
dsh plugin --profile headless remove dsh-auto-thinking-effort

# 真机跑一轮（会真的调模型，注意费用）
dsh --profile headless "谢谢"
dsh --profile headless "深入思考一下：为什么…"

# 只看判定不改请求：加一个 --patch 覆盖 dryRun: true
```

---

## 9. 交接清单

- [x] 代码 + 单测（62 个）+ CI workflow
- [x] 真机挂载与四种请求头证据（含对照组）
- [x] GUI 真机一轮（覆盖存储档位）
- [x] 设计决策与证据位置（`docs/design.md`）
- [x] 中英 README，含"真机验证 / 仅单测 / 未验证"三张表
- [ ] 同会话跨轮切换的真机验证（U1）
- [ ] 真实子代理跳过验证（U2）
- [ ] 发布到 npm
