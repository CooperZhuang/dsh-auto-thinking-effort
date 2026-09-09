# 设计决策 — dsh-auto-thinking-effort

每条决策都带**证据位置**（DSH 包内的行号指向 `@deepseek-ai/dsh/node_modules/@deepseek-ai/...`）。
改了行为就同步改这里。

---

## D1 — 分类用启发式，不调模型

**决定**：分类是一个纯函数：正则规则加权 + 结构特征，无网络、无模型调用。

**理由**：

1. 分类点在**每一轮的关键路径**上：`agent/pre-step` → `buildRequest` → `prepareCall` → 真正的流式请求。多一次模型调用 = 每轮多一次往返 + 一次费用 + 一个失败点。
2. 纯函数可单测、可复现、可解释（日志里能打出"为什么判成这个档位"）。模型分类做不到这三点。
3. 误判的代价不对称：把简单问题判难 = 多花点 token；把难题判简单 = 答案质量下降。启发式 + 保守默认带（D3）能把这个代价压到可接受。

**代价（明说）**：它读形状和用词，不读语义。反讽、领域黑话、极短的但极难的问题都可能判错。

**证据**：`dsh-agent-loop/lib/index.js:700-756`（`buildRequest` 每 step 调一次）；`dsh-llm/lib/types/index.d.ts:343`（`resolveModelInfo` 本身就是 async）。

**未定**：是否给"模棱两可"的情况加一条可选的轻量模型分类（`classifier: llm`）作为兜底。目前不做——见 D1 的理由 1。

---

## D2 — 只改 `reasoningEffort`

**决定**：插件只写 `reasoningEffort` 一个字段。不改 provider、model、system prompt、消息列表。

**理由**：

- 换模型是**另一个决定**，不该由一个按提问长度和关键词打分的启发式来做。
- 请求对象由 loop 深冻结并打标（`markAgentLoopRequest`），改写它的其他字段会绕过 loop 的记账（`request/header` 变更日志、缓存语义）。
- 只改一个字段 = 故障面只有一个字段。

**证据**：`dsh-llm/lib/types/call-config.d.ts:1-23`（`LlmCallConfig` 的字段就是"请求头状态"）；`dsh-agent-loop/lib/index.js:733-755`（header 变更才记 `request/header`）。

---

## D3 — 分数 0 落在"常规档"，不是最便宜的档

**决定**：默认阶梯里，无任何信号的提问（分数 0）→ `high`（provider 常规档）。只有明确降级信号才往下走。

**理由**：启发式读的是形状。**没有信号 ≠ 问题简单**，只等于"我们没有证据"。在证据缺失时选择更贵的一侧，是唯一能保证"不会因为分类器偷懒而变笨"的方向。

**证据**：`src/levels.ts` 的 `DEFAULT_LEVELS`（`high` 的上界是 11，非常宽）；`README.md` 的档位表。

---

## D4 — pin 用 `$strongest` / `$weakest` 令牌，不用档位 id

**决定**：内置的"明确要求深想/明确要求快答"两条规则 pin 到 `$strongest` / `$weakest`，在加载期解析成配置阶梯的最后一档/第一档。

**理由**：用户把阶梯换成三档或五档时，硬编码 `max` / `minimal` 会直接抛错（这两个 id 不存在了），或者更糟——静默失效。令牌让"最强/最弱"这个语义与阶梯解耦。

**证据**：`src/signals.ts`（`STRONGEST_LEVEL` / `WEAKEST_LEVEL`、两条 pin 规则）；`src/config.ts` 的 `prepareConfig`（令牌解析 + 未知 id 报错）；`tests/config.spec.ts` 的"自定义阶梯 + pin"用例。

---

## D5 — `agent/request` 用 `prepend: true` 注册

**决定**：`agent/request` 监听器注册在 host 平面且 `prepend: true`，因此是**最外层**监听器，其返回值即最终请求配置。

**为什么必须**：Web 入口给每个 agent 装 `installModelSelection`，它会把会话存储的 effort（`settings.yaml` 的 `agent-default-model.reasoningEffort`，或 GUI 模型选择器）重新盖到请求上——**而且它是在 agent 创建时才注册的，通常比 host 平面的插件晚**，所以不 prepend 也不一定输；但注册顺序不是契约，`prepend` 是。

**证据**：

- cordis waterfall 语义：`cordis/src/events.ts:225-243`（"Listeners run outermost-first … returns the outermost listener's return value"）。
- `installModelSelection` 的请求监听：`dsh-agent/lib/types/model-selection.js:33-47`。
- 谁装它：`dsh-web-app/cordis.patch.yml` 的 `session-controller` 行（`@deepseek-ai/dsh-api-session-controller`）；`dsh-api-session-controller/lib/types/agent.d.ts:96-116`。
- 反向证据（真的会输）：`tests/wiring.spec.ts` 第一个用例故意让 selection 监听器先注册；去掉 `prepend` 该用例失败。
- 真机证据：`session-76a1f832`（web-verify profile，装了 session-controller，settings 默认 `high`，实际请求 `off`）。

**逃生门**：`respectExplicitEffort: true` → 请求上已有显式 effort 就完全让位。

---

## D6 — 以"轮"为决策单位；steering 只升不降；过期记录不套用

**决定**：`agent/pre-step` 看到的**用户消息**（`source.kind === 'user'`）决定这一轮；同一轮的后续 step 沿用；同一轮内的追加消息只能抬高，除非它是显式 pin；`forTurn(turn)` 只对**完全相同的轮号**作答。

**理由**：

- 一次工具调用之后的那一步没有用户消息，不能因为"没看到用户输入"就把档位重置。
- "好的，继续"不是"前面的分析不重要了"的证据。
- 会话恢复 / 乱序请求下，绝不能把上一轮的档位套到这一轮。

**证据**：`src/state.ts` 的 `observe` / `forTurn`；`tests/state.spec.ts`；`tests/wiring.spec.ts` 的"keeps a turn at its level across steps"与"raises, but never lowers, a turn on steering"。

---

## D7 — 用精确模型声明的能力钳制，查不到就不动

**决定**：先 `ctx.llm.resolveModelInfo(provider, model)` 取该**精确路由**声明的 effort 列表，再在阶梯上取最近的一档（同距偏强）。查不到能力 / 没挂 `ctx.llm` / 查询失败 → 原样返回并只警告一次。

**理由**：

- effort id 是 adapter 的私有词汇，插件不能假设它认识 `off/low/high/max`。
- loop 的 `prepareCall` 会对**不支持的显式 effort 直接拒绝**（不钳制、不别名），所以钳制必须由插件自己做，否则一个换 provider 的部署会直接报错。

**证据**：`dsh-llm/lib/types/index.d.ts:343-357`（`resolveModelInfo`、`resolveCallConfig`："Unsupported explicit efforts reject before provider I/O; no clamping or aliasing is performed"）；`dsh-agent-loop/lib/index.js:726-731`（`prepareCall` 失败路径）；`src/levels.ts` 的 `resolveEffort`；`tests/levels.spec.ts`、`tests/wiring.spec.ts` 的钳制用例。

---

## D8 — 子代理默认不接管

**决定**：`session.header.origin === 'subagent'` 的会话默认跳过（`applyToSubagents: false`）。

**理由**：子代理的 provider/model/effort 由调用方在 `subagent` 工具里显式指定（`reasoning_effort` 字段），那是一次**有意的选择**。插件按子任务的 prompt 关键词去覆盖它，等于替调用方改了它明确指定过的东西。

**证据**：`dsh-session/lib/types/types.d.ts:79-83`（`origin?: 'subagent'`）；`dsh-tool-subagent/lib/types/model-selection.d.ts:35-78`（子代理的 effort 解析）；`tests/wiring.spec.ts` 的 subagent 用例。

---

## D9 — 配置在加载期 fail loud

**决定**：正则编不过、pin 指向不存在的档位、`maxScore` 不严格递增、`maxChars` 非法 → 直接抛错，插件树启动失败。

**理由**：这些错误在运行期表现为"某一轮档位奇怪"，极难定位；在加载期就是一行堆栈。DSH 的插件行本来就有 `assertEntriesLoaded` 这类 fail-loud 机制。

**证据**：`src/config.ts` 的 `prepareConfig`、`src/levels.ts` 的 `assertLevels`、`src/signals.ts` 的 `compileRules`；`tests/config.spec.ts`、`tests/levels.spec.ts`。

---

## 未定 / 开放问题

| 编号 | 问题 | 现状 |
|---|---|---|
| U1 | 同一会话内跨轮切换的真机验证（turn1 `max` → turn2 `off`，`request/header` reason=change） | headless 是一次性任务，没有多轮入口；只在进程内测过。可选路径：临时 `web-verify` profile + 浏览器连续发两条消息（注意 `playwright-cli` 的浏览器是跨会话共享的，见 `docs/handoff.md` 陷阱 6） |
| U2 | 真实子代理会话的跳过行为 | 只在进程内用假 header 测过 |
| U3 | 非 DeepSeek provider 的钳制路径 | 只用假 `resolveModelInfo` 测过 |
| U4 | 是否要一条可选的模型分类兜底（D1） | 不做；若要做，必须在 `agent/pre-step` 之外异步预取，且失败时回退启发式 |
| U5 | 是否允许规则级 `model` 覆盖（"难题换更强模型"） | 与 D2 冲突，暂不做 |
