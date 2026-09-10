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

## D13 — 下限：默认**不设**，`auto` 可以关掉思考

**决定**：`autoFloorLevel` 默认是阶梯最弱那一档（`minimal`），也就是**没有下限**——`auto` 判到 `minimal`（客套、机械操作）时真的会发 `off`。想收紧就把 `autoFloorLevel` 设成 `low`（或更高的档位）。

**为什么和 oh-my-pi 不同**：他们的 `clampAutoThinkingEffort` 有硬下限（"`auto` never resolves below Low"），理由是"省下的 token 换不回一次答错"。我们第一版照抄了这条，但用户明确要求允许 `off`：在"客套 / `git status` 这类纯机械请求"上关掉思考是**这个插件最实际的省钱点**，而这类请求本来就不需要推理。所以策略改成**默认放开、可配置收紧**，`low` 下限仍然一条配置就能拿回来。

**代价（明说）**：判定失误时可能把一轮本该思考的请求降到 `off`。防御手段是上限一侧（D14，只有 pin 到 `max`）与默认带（D3，无信号落 `high`）：`off` 只出现在**负分信号**明确命中的轮次。

**证据**：`src/config.ts` 的 `autoFloorLevel` 默认值；`src/levels.ts` 的 `resolveEffort` `floor` 选项；`tests/levels.spec.ts`（下限开启/关闭两侧）、`tests/wiring.spec.ts`（"lets the lowest band turn thinking off by default" / "holds the lowest band at `low` when the floor is raised"）；真机 `dsh --profile headless "git status"` → `off`（`session-3af16e67`，加了下限时是 `low`）。

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

## D18 — 配置有两个层：profile 行是 base，`settings.yaml` 是用户层（且热生效）

**决定**：插件在 `ctx.settings` 上注册命名空间 `auto-thinking-effort`（`applies: 'live'`），把 profile 那一行 `config:` 当作 **base 层**、把 `~/.dsh/settings.yaml` 的同名段当作 **用户层**。解析顺序：schema 默认值 → base → 用户层，用户层优先。

**为什么**：

| 问题 | 这一层解决的 |
|---|---|
| 改一个上限要重启 `dsh web` | 命名空间是 `live` 的：文件一改，**跑着的 host 自己重配**（跟 settings 的 watch/commit 同一条路）。bundle 不热加载（陷阱 #10），但 settings 热生效，两者互补。 |
| 一个以 id 为目标的 profile 覆盖**会替换整行 config**，写一个键得重述全部键 | 用户层是**合并**的：只写想改的键。 |
| 插件不想把 `@deepseek-ai/dsh-settings` 变成硬依赖 | 接口按**结构**声明（`SettingsRegistry`/`SettingsScope`，镜像 `dsh-settings/lib/types/index.d.ts:206`/`:84-113`）；没挂 provider 就跑 profile 行。 |
| 写错配置把正在跑的会话弄坏 | `validate` 里调 `prepareConfig`：跨字段非法（下限排到上限上面、bound 写了不存在的档位）在**写入点**就被拒，保留上一份可用配置并警告。 |

**为什么用 `ctx.inject(['settings'])` 而不是 `ctx.get('settings')`**：cordis 里服务只有“提供它的 fiber 已 active”才读得到（`context.d.ts`：`get(name, strict=true)`，“without the inject requirement” 要走 `ctx.reflect`），而 settings provider 的文档是异步读完的。第一版用 `ctx.get` 实测**静默拿不到服务**（真机：`autoFloorLevel: low` 完全不生效）。`ctx.inject` 是 DSH 自己的写法（`dsh-agent-default-model/lib/index.js:44`、`dsh-theme/lib/index.js:87` 等 15+ 处），它会在服务出现时回调、在服务替换时重跑，而且在没有 provider 的部署里**永远不会执行** —— 正好是“可选依赖”的语义。

**真机验证**：

| 场景 | 做法 | 结果 | 证据 |
|---|---|---|---|
| 用户层在加载期被读到 | `dsh --profile headless --patch <settings 指向临时文件>`，文件里 `autoThinkingEffort.autoFloorLevel: low`（base 行仍是 `minimal`） | `git status` → `low`（base 单独跑同句是 `off`） | `session-518c09e2` vs `session-3af16e67` |
| **跑着的 host 热重配** | 同一个 `dsh --profile web --port 0` 进程（PID 18604，10:03:40 启动，全程未重启），10:05 把 `autoCeilingLevel` 从 `max` 改成 `high` → 发同一句重负载；10:08 改回 `max` → 再发同一句。最终构建上又做了一次单点复核：启动值 `high`，改文件为 `max` 后同一句拿到 `max` | turn A → `high`，turn B → `max`（只有文件变了；provider 自己的默认是 `high`，所以 `max` 只可能来自插件） | `session-0f47f1c6` / `session-b7f7a469`；最终构建 `session-ce7ffac5` |

**代价 / 边界**：非法的**外部**编辑由 settings 层拦住（保留上一份 + 警告）；`adopt()` 里那次 `buildRuntime` 的 try/catch 是第二道防线（provider 忽略 `validate` 时仍不会把会话弄坏）。档位改动（`autoEffortId`/name/description）会被识别并重新安装 Auto 档位；`enabled` 翻转同样会重装/拆掉，但兜底 listener 永远留着（D10）。重配会清掉 `warned`/能力缓存/分类缓存；**不清**已有的 `AgentState`（每轮记录）—— 它只按 id 比强弱（找不到当 -1），清掉反而会让进行中的一轮丢掉自己的决策。

**证据**：`src/index.ts`（`SETTINGS_NAMESPACE`、`ctx.inject` 块）、`tests/wiring.spec.ts` 的 `settings namespace` 组（6 个用例：注册参数、无 provider 降级、用户层在加载期生效、热重配、禁用后不再广告档位、非法值保留上一份）。

---

## D19 — 浏览器半边：一张由本插件自己拥有的配置卡片

**决定**：包自己提供浏览器半边（`src/client.js` → `lib/client.js`，`package.json` 声明 `dsh.client`），往 `settings.plugin.item` 槽里以「自己的 settings 命名空间」为 key 注册一张配置卡片。

**为什么必须自己提供**：「插件」设置分区只把**被服务的命名空间**与**注册在同一 key 上的卡片**配对——「被服务却无人认领的命名空间什么都不渲染」（`dsh-client-ui-settings-plugins/README.zh.md`）。D18 只让命名空间进了「插件列表」的只读清单，所以用户在 GUI 里看不到任何可编辑入口。而官方文档明确这本就是给外部插件留的口子：“Keying on the namespace is what lets a plugin distributed outside this repository contribute a card”（`slot-contract.d.ts`）。

**为什么手写而不是构建**：浏览器半边必须以 **client bundle**（经典脚本 + `window.__ModuleLoader__.load({id, factory})` 的惰性 CJS factory）形式交付，而产出该形状的 `tsdown.client.ts` 预设位于 DSH 仓库内部、不是已发布的包（官方 README 把这列为已知限制：“仓库之外的插件得自行复刻该构建”）。与其复刻一份会腐烂的预设，不如直接写那个形状：没有打包器、没有 externals（React 与槽服务由外壳播种）、整个浏览器半边是一个可审阅的文件。代价：**它不被 `tsc` 检查**（`eslint` 仍看它，`scripts/build-client.mjs` 在构建时校验 id 与 bundle 形状）；这是本仓库唯一没有类型的源码文件。

**卡片做什么**：绑定 `ctx.settingsScope.bind({ namespace: 'auto-thinking-effort' })`，渲染 13 个字段（开关/下拉/数字），暂存草稿、逐字段「已覆盖」徒标与重置，保存时把全部草稿当作**一次** `mutate`（带草稿开始时的 revision 围栏），留空即 `unset`（重新继承 base）。**不**渲染 `levels`/`rules` 这类结构化配置，而是在卡片里指向 `settings.yaml`。

**边界**：命名空间不可用（`status !== 'ready'`）时卡片什么都不渲染（官方 PluginCard 的约定）；`writable: false`（memory 模式）时控件全部禁用；写入被 revision 拒绝时保留草稿并把错误显示在卡片里（不静默丢弃）。

**真机验证**（DSH 0.1.2-rc.1 / 全新 `dsh --profile web --port 0` 进程）：

| 场景 | 结果 |
|---|---|
| 卡片出现在「设置 → 插件 → 插件配置」 | 与官方卡片（插件市场/终端…）并列；展开后 13 个字段、base 值与「已覆盖」标记都对 |
| 保存写入 Host 文档 | 选 `autoCeilingLevel: high` → 保存 → scratch `settings.yaml` 里该段变成 `high`，注释与其它段未动 |
| **GUI 写入被运行中的 host 采纳** | 同一进程内用卡片把 `autoFloorLevel` 改成 `low` → 新会话发 `git status` → 请求头 `"low"`（base 行单独跑同句是 `"off"`） |
| 重置 = 清除覆盖 | 点该字段的「重置」→ 保存 → `settings.yaml` 里 `autoFloorLevel` 一行消失（回到继承 base 的 `minimal`） |

**证据**：`src/client.js`、`scripts/build-client.mjs`、`package.json`（`dsh.client` + `exports['./client']` + `files`）、`eslint.config.js`（浏览器全局 + `sourceType: 'script'`）；session `session-b340648b`（GUI 写入后的 `git status` 轮次）。

---

## 未定 / 开放问题

| 编号 | 问题 | 现状 |
|---|---|---|
| U2 | 真实子代理会话的跳过行为 | 只在进程内用假 header 测过（`applyToSubagents: false`） |
| U3 | 非 DeepSeek provider 的钳制路径 | 只用假 `resolveModelInfo` 测过 |
| U4 | 是否要一条可选的模型分类兜底（D1） | 不做（见 D17）；若要做，必须在 `agent/pre-step` 之外异步预取（`purpose: 'session-title'/'compaction'` 的旁路），且失败时回退启发式 |
| U5 | 是否允许规则级 `model` 覆盖（"难题换更强模型"） | 与 D2 冲突，暂不做 |
| U6 | 卸载插件后仍有会话选着 Auto | 预期是会话内显式报 `UNSUPPORTED_REASONING_EFFORT`（D10 的 `prepareCall` 不包策略）；没真机跑过 |
| U7 | GUI 里的“配置菜单” | **已关闭**（D19）：本包自带浏览器半边，卡片在「设置 → 插件 → 插件配置」里可编辑并即时生效 |

> **U1（同会话跨轮切换的真机验证）已关闭**：真机 GUI 会话 `session-11eeae50` 里，turn 1（Auto）写 `off`、turn 2（手动 Low）写 `low`，同一会话两条不同的 `request/header`。
