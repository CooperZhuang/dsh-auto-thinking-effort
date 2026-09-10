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

**逃生门**：v0.2 起不再需要——手动档位本来就不被覆盖（D11）。

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

## D10 — Auto 是"注入到能力列表里的合成档位"

**决定**：插件把 `auto` 这个 id 注入到 `ctx.llm.resolveModelInfo(...).reasoning.efforts` 的最前面，并设为 advertised `defaultEffort`；同时让 `resolveCallConfig` 放行这个 id；落盘全局默认时再把它剥掉。

**为什么不能用更"正规"的做法**：

- 选择器的档位列表来自 `resolveModelInfo`（`dsh-api-session-controller/lib/types/catalog.js:14-26`），选中后由 `resolveCallConfig` 校验 effort 是否属于 adapter（`lib/types/commands.js:126-132`；校验逻辑在 `dsh-llm/lib/index.js:1561-1586`，未声明的 effort 直接抛 `UNSUPPORTED_REASONING_EFFORT`）。**没有"第三方贡献档位"的扩展点。**
- 想包一层 adapter 也不行：`registerAdapter` 对已注册的 provider 直接抛 `DUPLICATE_ADAPTER`（`dsh-llm/lib/index.js:1272`），而且拿不到既有 adapter 实例。

**为什么只包这三个方法**：

| 方法 | 只影响 |
|---|---|
| `resolveModelInfo` | 选择器目录 + 本插件自己的能力查询（后者会把 auto 滤掉） |
| `resolveCallConfig` | 选择阶段校验（只对 auto 短路） |
| `agentDefaultModel.saveSelection` | 全局默认落盘（把 auto 变成"无显式档位"） |

**`prepareCall` 故意不包**：它是真正会走到 adapter 的那条路。不包 → 万一 auto 漏过去，得到的是会话内 `UNSUPPORTED_REASONING_EFFORT` 报错（可见、可修），而不是一个 `reasoning_effort: "auto"` 的畸形 HTTP 请求。

**已验证**：`tests/capability.spec.ts`（注入/放行/落盘剥离/dispose 恢复/幂等/无 llm 服务降级）；真机 GUI 选择器里确实出现 Auto 且能选中（`session-11eeae50`，服务 127.0.0.1:3745）。

---

## D11 — 具体档位永远原样返回（手动优先）

**决定**：`agent/request` 只在两种情况下改写 effort：请求上带着 `autoEffortId`，或请求上没有 effort 且 `autoWhenUnset: true`。带着 `off`/`low`/`high`/`max` 的请求**原对象返回**。

**理由**：用户明确选了档位就是最强的证据，不该被一个按关键词打分的启发式推翻。v0.1 默认"永远覆盖"，用户直接指出这不对。

**证据**：`src/index.ts` 的 `decideEffort`（`auto` 判定）；`tests/wiring.spec.ts` 的 `manual gears` 三个用例；真机同一会话里先 Auto（"谢谢"→`off`）再手动 Low（"深入思考一下…"→`low`），见 `session-11eeae50`。

---

## D12 — Auto 不落进全局默认

**决定**：包一层 `agentDefaultModel.saveSelection`，把 `auto` 从落盘的选择里剥掉（存成"无显式档位"）。

**理由**：在 GUI 里选一次 Auto 会把选择存进 `settings.yaml` 的 `agent-default-model`，而**所有 profile 都读这个文件**。一个没装本插件的 profile 拿到 `auto` 后，会在 `prepareCall` 被 `UNSUPPORTED_REASONING_EFFORT` 拒掉——每一轮都失败，而且原因极难猜。

剥掉之后：装了插件的 profile 读到"无显式档位"→ 因为 `autoWhenUnset: true` 仍是自动；没装的 profile 读到"无显式档位"→ provider 默认。两边都对。

**证据**：`tests/capability.spec.ts` 的落盘守卫用例；真机选 Auto 后 `settings.yaml` 的 `agent-default-model` 里确实没有 `reasoningEffort`。

---

## D13 — 下限：`auto` 不把思考关掉

**决定**：`autoFloorLevel` 默认 `low`。`auto` 判到 `minimal`（客套、机械操作）时，实际 effort 被抬到 `low`；把该值设成阶梯最弱那一档（或 `$weakest`）才允许到 `off`。

**理由**：参考 oh-my-pi 的 `clampAutoThinkingEffort`——它的注释写得很直接："`auto` never resolves below Low"。在编码场景里，"省下一点思考 token"换不回一次答错的代价；而"关掉思考"恰恰是用户最不可能想要的自动行为。

**证据**：`src/levels.ts` 的 `resolveEffort` 的 `floor` 选项；`tests/levels.spec.ts` 的下限用例；真机 `dsh --profile headless "git status"` → `low`（`session-4987185c`，此前是 `off`）。

---

## D14 — 上限：分数算出来的档位不进最高档

**决定**：`autoCeilingLevel` 默认 `high`。`classify` 选出的档位若高于天花板就压到天花板；**pin 不受约束**。

**理由**：同样是 oh-my-pi 的策略——`providers.autoThinkingMaxEffort` 默认 `xhigh`，"keeps the classifier one tier below the top, so only `ultrathink` reaches `max`"。把最高档留给"用户明确要求"这一种情况，让启发式的误判成本有上界。

**代价（明说）**：一个确实很难、但用户没写"深入思考"的问题，现在最多到 `high`。这是有意的取舍：宁可让用户多说一句，也不让正则决定要不要烧最高档。

**证据**：`src/classify.ts` 的 ceiling 应用（附 `capped at <id>` 理由）；`tests/classify.spec.ts`、`tests/wiring.spec.ts`；真机无 pin 的重负载文本 → `high`（`session-771ee9b3`），而 pin 的同一类问题 → `max`（`session-a82f0524`）。

---

## D15 — pin 只在正文里匹配

**决定**：pin 规则默认 `proseOnly: true`——先剥掉围栏代码块、行内代码、HTML 注释与标签，再匹配。加权规则仍匹配原文。

**理由**：来自 oh-my-pi 的 magic-keyword 匹配规则（"Fenced code blocks … inline code spans, HTML/XML comments/tags/elements, and their contents are ignored"，且 `orchestrate.ts`、`foo::orchestrate`、`orchestrate()` 都不触发）。pin 是**改变行为**的开关，被代码或路径误触发是不可接受的；而加权规则要的恰恰相反——粘贴的 `TypeError` 必须算证据。

**代价**：代码块里的关键词不再 pin（这正是目的）；`stripNonProse` 用正则剥，未闭合的围栏不剥（可接受）。

**证据**：`src/classify.ts` 的 `stripNonProse`；`tests/classify.spec.ts` 的"ignores a pin keyword inside code"。

---

## D16 — 钳制方向：从下限一侧回答，不从请求一侧

**决定**：`resolveEffort` 先按下限筛出合法池（池空则回落到全部声明档位），再取**池里不超过请求的最高档**；请求低于整个池时取池的最低档。

**理由**：旧实现取"阶梯上最近的档位"，在稀疏阶梯上会向下跳。oh-my-pi 的注释点出了根因：*"capping the request alone is not enough, because a sparse ladder snaps an excluded request back up"*——反过来也成立：按距离取最近会让一个 `low` 请求在 `["off","max"]` 上落到 `off`，直接违反下限。下限是硬约束，请求只是偏好。

**证据**：`src/levels.ts` 的 `resolveEffort`；`tests/levels.spec.ts` 的稀疏阶梯用例（`low` + `['off','max']` + floor=low → `max`）。

---

## D17 — 模型分类是**可选后端**，默认关

**决定**：`classifier` 有两个取值：`heuristic`（默认，纯函数）与 `model`（一次小模型调用）。模型后端只借鉴 oh-my-pi 那条路的**契约**，不改变默认行为。

**契约（都是为了让「多一次调用」不变成「多一个故障点」）**：

| 规则 | 理由 |
|---|---|
| 只在**没有 pin** 的轮次调用 | 用户写了 `ultrathink` 就是最强证据，不值得再花一次调用 |
| 提示里只出现 `floor..ceiling` 之间的档位 | 策略上限（D14）不能被模型绕过；这是 oh-my-pi 用 `{{#if allowMax}}` 做的同一件事 |
| 在 `agent/pre-step` 发起、在 `agent/request` await | 这段延迟与提示组装重叠，而不是加在后面 |
| `AbortSignal.timeout` + 回合自己的 abort signal | 分类器永远不能拖住一轮 |
| 任何失败（无模型/报错/超时/解析不出/无 route）→ 返回 `undefined` | 调用方保留它已经算好的启发式判定；这一轮照常跑（oh-my-pi 也是「抛错、由调用方回落」） |
| 答案按 `route+candidates+text` 缓存（64 条） | 重试与重复消息不重复付费 |
| 调用直接走 `ctx.llm.stream`，**不经过 `agent/request`** | 分类调用与被分类的请求在结构上不可能互相干扰 |
| 每个档位的 `description` 参与渲染提示 | 自定义阶梯能向模型解释自己（`LevelSpec.description`） |

**为什么默认仍然是启发式**：按 D1，默认路径要零延迟、确定性、可复现。模型后端每轮多一次请求（他们用 `tiny` 角色和本地 on-device 模型摊薄，我们没有等价的小模型角色概念，所以让用户指定 `classifierModel`）。

**真机验证**（`deepseek-v4-flash` 作为分类器，同一句话）：启发式 `high` → 模型 `low`（模型判断它 trivial 并覆盖了启发式）；`classifierModel` 指向不存在的模型时回落到 `high` 且请求照常发出（`session-718b1f73`）。

**证据**：`src/model-classifier.ts`、`tests/model-classifier.spec.ts`（15 个用例，含超时与四种失败）、`tests/wiring.spec.ts` 的 `model classifier` 组；[oh-my-pi classifier.ts](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/auto-thinking/classifier.ts)、[分类器 prompt](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/prompts/system/auto-thinking-difficulty.md)。

---

## 未定 / 开放问题

| 编号 | 问题 | 现状 |
|---|---|---|
| U2 | 真实子代理会话的跳过行为 | 只在进程内用假 header 测过（`applyToSubagents: false`） |
| U3 | 非 DeepSeek provider 的钳制路径 | 只用假 `resolveModelInfo` 测过 |
| U4 | 是否要一条可选的模型分类兜底（D1） | 不做（见 D17）；若要做，必须在 `agent/pre-step` 之外异步预取（`purpose: 'session-title'/'compaction'` 的旁路），且失败时回退启发式 |
| U5 | 是否允许规则级 `model` 覆盖（"难题换更强模型"） | 与 D2 冲突，暂不做 |
| U6 | 卸载插件后仍有会话选着 Auto | 预期是会话内显式报 `UNSUPPORTED_REASONING_EFFORT`（D10 的 `prepareCall` 不包策略）；没真机跑过 |

> **U1（同会话跨轮切换的真机验证）已关闭**：真机 GUI 会话 `session-11eeae50` 里，turn 1（Auto）写 `off`、turn 2（手动 Low）写 `low`，同一会话两条不同的 `request/header`。
