# dsh-auto-thinking-effort

> DSH（DeepSeek Harness）插件：在模型选择器里加一个 **Auto（自动）档位**。选中它，插件就**每一轮**根据你的提问自己切 effort；选 `off`/`low`/`high`/`max` 则完全是手动，插件一点都不插手。
>
> 问"谢谢"→ 关掉思考；问"为什么这里会死锁，分析并证明"→ 拉到最高档。
>
> [English README →](./README_EN.md)

---

## 它做什么（以及不做什么）

### 档位

装好后模型选择器的推理等级菜单变成 **Auto / Off / Low / High / Max**（`Auto` 是本插件加的那一个，其余四个原样保留）：

| 会话里的选择 | 行为 |
|---|---|
| **Auto**（插件加的合成档位） | 插件**每轮**读你的消息决定 effort |
| 没有显式档位（`autoWhenUnset`） | 同上——没选 = 自动 |
| `Off` / `Low` / `High` / `Max` | **完全不动**，手动档位永远优先 |

所以"想手动指定"不需要额外操作：**选一个具体档位就行**。插件只在请求上带着 Auto（或压根没带 effort）时才出手。

### 边界

- **只改 `reasoningEffort`**。provider、model、system prompt、消息列表一律不动。最坏情况是"这轮想得多了/少了"，永远不会变成"另一段对话"。
- **Auto 这个 id 绝不会发给模型**。它只是选择器里的一个标记；`agent/request` 在 `prepareCall` 之前就把它换成模型真正支持的档位。哪怕插件被 `enabled: false` 关掉，也留着一条"兜底改写"监听器，保证它不会漏到 provider 请求里。
- **不调模型做分类**。分类是纯函数（正则 + 结构特征），零延迟、零成本、可单测、可复现。代价是它读的是**形状和用词**，不是语义——所以默认档位是 provider 的常规档，而不是最便宜的档。
- **Auto 不会污染全局默认**：插件拦掉 `agent-default-model.saveSelection` 里的 Auto，落盘的是"没有显式档位"。这样别的没装插件的 profile 读到的是 provider 默认，不会因为一个它们不认识的 id 而报错。

---

## 安装

```powershell
# 本地 checkout（当前状态：尚未发布到 npm，用这一种）
dsh plugin --profile web add C:\CodeRepository\dsh-auto-thinking-effort

# 发布后可以直接按包名装（插件行会随 bundle patch 自动挂载）
dsh plugin --profile web add dsh-auto-thinking-effort
```

装完 `dsh --profile web --dump-config` 里应能看到：

```yaml
- id: auto-thinking-effort
  name: dsh-auto-thinking-effort
  config:
    enabled: true
    dryRun: false
    applyToSubagents: false
    autoEffortId: auto
    autoEffortName: Auto
    autoEffortDescription: 每轮按提问自动选择档位
```

> **改 bundle 不会热加载**：`patchReload: live` 只监听 profile 的 `cordis.patch.yml`（`dsh-app-boot/lib/index.js:1075-1095`），装/卸插件改的是 `package.json` 的 bundles 列表，所以**要重启 `dsh web` 才生效**，不会打断正在跑的会话。

想先看它**打算**怎么判、但先不改请求：把 `dryRun: true` 打开，日志里会打出每轮的档位与理由。

---

## 档位阶梯

默认阶梯对齐 DeepSeek 的四个档（`off` / `low` / `high` / `max`）。`maxScore` 是**该档的分数上界（含）**，最后一档必须不写上界（兜底）。

| 档位 id | 请求的 effort | 分数区间 | 含义 |
|---|---|---|---|
| `minimal` | `off` | ≤ −6 | 客套、纯机械操作（**默认被下限抬到 `low`**，见下） |
| `low` | `low` | −5 … −2 | 简单但要认真回答一句 |
| `high` | `high` | −1 … 11 | **默认带**：普通提问、日常编码 |
| `max` | `max` | ≥ 12 或用户明确要求 | 多信号叠加的硬任务（**默认只有显式 pin 能到**） |

分数 0（没有任何信号）落在 `high`——刻意如此：猜错方向时，"多想一点"比"少想一点"安全。

### 下限与上限（默认收窄的两端）

借鉴 oh-my-pi 的做法，`auto` 默认**不碰两端**：

- **下限 `autoFloorLevel: low`**：`auto` 不会把思考关掉。客套/机械请求最多降到 `low`，不会到 `off`。想恢复"可以关思考"就设成 `minimal`。
- **上限 `autoCeilingLevel: high`**：**分数算出来的**档位最高只到 `high`；只有**显式 pin**（`ultrathink` / `think hard` / `深入思考`）才允许到 `max`。pin 是用户明说的，不受天花板约束。

两边都按"阶梯上的档位"表达，也可以用 `$weakest` / `$strongest` 令牌（自定义阶梯时特别有用）。

### 什么在加减分

**强制档（pin，直接短路，不做加权）**

| 触发 | 档位 |
|---|---|
| `ultrathink` / `think hard` / `深入思考` / `仔细分析` / `thoroughly analyze` | 最强档 |
| `quick` / `简单说` / `一句话` / `不用想` / `直接给` | 最弱档 |

> - pin 用 `$strongest` / `$weakest` 令牌，所以你把阶梯换成三档、五档，这两条规则照样有效。
> - pin **只在正文里匹配**：围栏代码块、行内代码、`<!-- 注释 -->`、XML/HTML 标签里的字一律不算（`// think hard` 不会触发）。加权规则不受此限制，粘贴的报错文本仍算证据。

**加权信号（节选，完整列表见 `src/signals.ts`）**

| 信号 | 权重 |
|---|---|
| 问因果：`why` / `为什么` / `根因` / `怎么会` | +5 |
| 数学/算法：`prove` / `证明` / `推导` / `算法` / `复杂度` | +4 |
| 设计/重构/迁移：`design` / `架构` / `重构` / `migration` | +4 |
| 分析/排查/审查：`analyze` / `排查` / `调试` / `review` | +3 |
| 并发/安全/回归：`deadlock` / `死锁` / `memory leak` / `安全` | +3 |
| 上一轮没成：`still fails` / `还是不行` / `不对` | +3 |
| 报错证据：`TypeError` / `Traceback` / `报错` | +2 |
| `step by step` / `一步步` / `详细解释` | +2 |
| 跨文件/全仓：`codebase` / `整个项目` / `所有文件` | +2 |
| 多条需求：`另外` / `同时` / `and also` | +2 |
| 纯机械：`git status` / `列一下` / `跑一下测试` | −3 |
| 客套：`谢谢` / `好的` / `thanks` | −2 |

**结构特征（代码算出来的，不用写正则）**

| 特征 | 权重 |
|---|---|
| 正文 ≥ 600 字符 | +1 |
| 2 个以上代码块 / 1 个代码块 | +3 / +2 |
| 3 个以上问号 / 2 个问号 | +2 / +1 |
| 3 行以上列表项 | +1 |
| ≤ 24 字符且无代码块 | −3 |

> **长度和礼貌刻意只算很弱的证据**：难度不等于啰嗦，也不等于客气。这两条是从 oh-my-pi 的分类器 prompt（*"judge inherent task difficulty, not phrasing politeness or verbosity"*）学来的。

**两条状态机规则**

- **裸接续继承上一轮**：`继续` / `go on` 这类只要求"接着做"的消息，若没带新的升级信号，就沿用上一轮的档位（而不是因为"消息很短"掉到 `low`）。
- **轮内 steering 只升不降**：同一轮里追加一句"好的，继续"不会把已经拉高的档位压回去；但用户明确 pin（"直接给答案"）可以压。

---

## 配置

```yaml
- insert:
    - id: auto-thinking-effort
      name: 'dsh-auto-thinking-effort'
      config:
        enabled: true
        dryRun: false
        applyToSubagents: false
        autoEffortId: auto
        autoEffortName: Auto
        autoEffortDescription: 每轮按提问自动选择档位
        autoWhenUnset: true
        autoFloorLevel: low
        autoCeilingLevel: high
        logDecisions: true
        inheritOnContinuation: true
        builtinRules: true
        maxChars: 8000
        levels:
          - { id: minimal, effort: off, maxScore: -6 }
          - { id: low, effort: low, maxScore: -2 }
          - { id: high, effort: high, maxScore: 11 }
          - { id: max, effort: max }          # 最后一档不写 maxScore
        rules:
          - { pattern: 'deploy|上线', level: max, note: '发布相关' }
          - { pattern: '写个?周报', weight: -2 }
```

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关。关闭时不再加 Auto 档位、不再分类，但保留兜底改写（防止已存的 Auto 漏到 provider）。 |
| `dryRun` | `false` | 只判定 + 打日志，**不**改写请求。 |
| `levels` | 见上表 | 分数→档位→effort 的阶梯；空列表 = 用默认阶梯。 |
| `builtinRules` | `true` | 是否启用内置规则（关掉只用自己的 `rules`）。 |
| `rules` | `[]` | 追加规则；`level` 是 pin，`weight` 是加减分。 |
| `autoEffortId` | `auto` | 合成档位的 id（会出现在会话选择与选择器里）。 |
| `autoEffortName` | `Auto` | 选择器里显示的名字。 |
| `autoEffortDescription` | 见上 | 选择器里的一句话说明。 |
| `autoWhenUnset` | `true` | 请求上没有显式档位时是否也算自动。 |
| `autoFloorLevel` | `low` | `auto` 允许的最低档位；设成阶梯最弱那档（如 `minimal`）就允许关掉思考。 |
| `autoCeilingLevel` | `high` | **分数算出**的档位上限；pin 不受它约束。 |
| `applyToSubagents` | `false` | 是否也管子代理会话（子代理通常由调用方指定路线，默认不动）。 |
| `inheritOnContinuation` | `true` | 裸接续是否继承上一轮档位。 |
| `logDecisions` | `true` | 每轮打一行 info 日志：档位、分数、理由。 |
| `maxChars` | `8000` | 分类时最多看多少字符（超长会保留头 60% + 尾 40%）。 |

### 规则写法

- `pattern`：正则源码，默认大小写不敏感（`flags: 'i'`）。**禁止 `g` / `y`**——它们会让 `lastIndex` 有状态，同一个函数对不同调用给出不同答案。
- `level`：pin 到某个档位 id，或 `$strongest` / `$weakest`。
- `weight`：加权分数，可为负。
- `proseOnly`：是否只在**正文**里匹配（默认：pin 规则 `true`，加权规则 `false`）。
- `note`：日志与决策记录里的理由。

加载期就会 fail loud：正则编不过、`level` 指向不存在的档位、`maxScore` 不递增、`maxChars` 非法、`autoEffortId` 为空、`autoFloorLevel`/`autoCeilingLevel` 指向不存在的档位或下限高于上限……都会直接抛错，而不是等到第一轮才悄悄失效。

---

## 钳制方向：从下限一侧回答，不从请求一侧

模型声明的档位和阶梯不重合时（换 provider、自定义阶梯），插件**先按下限筛出合法池，再取池里不超过请求的最高档**；请求低于整个池时就取池的最低档。

这条方向是刻意选的：稀疏阶梯 `["off","max"]` 遇到 `low` 请求，**不能**用 `off` 回答——下限才是硬约束，请求只是偏好。这也是 oh-my-pi `clampAutoThinkingEffort` 的语义。

---

## 与 oh-my-pi（`omp`）的差异

参考实现：[`auto-thinking/classifier.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/auto-thinking/classifier.ts)、[`thinking.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/thinking.ts)。

| 维度 | oh-my-pi | 本插件 |
|---|---|---|
| 分类方式 | **一次小模型调用**（`tiny`/`smol`，或本地 on-device <2B 模型），prompt 只让它回一个词 | 纯启发式，**零调用** |
| `auto` 住在哪 | agent 层自己的 selector，**永远不是 Effort**，provider 映射前就解析掉 | 注入进模型档位列表的合成档位（DSH 没有贡献扩展点） |
| 下限 | 不低于 `low` | 默认同样不低于 `low`（`autoFloorLevel`） |
| 上限 | 默认 `xhigh`（差一档），只有 `ultrathink` 到 `max` | 默认 `high`，只有显式 pin 到 `max` |
| 钳制 | 下限池内取不超过请求的最高档 | 已对齐（见上一节） |
| 失败处理 | 抛错 → 回落到 provisional level，这一轮照常跑 | 无记录 → 默认带；请求路径永不抛 |

**没有抄的**：小模型分类。它每轮多一次模型调用（他们用 tiny 模型和本地模型摊薄成本），而我们按 `docs/design.md` D1 把"零延迟、确定性、可复现"放在首位。想加的话，DSH 有现成旁路（`purpose: 'session-title' | 'compaction'` 的调用不经过 `agent/request`），见 D17/U4。

---

## 为什么手动档位不会被覆盖

`agent/request` 是一条 **waterfall**：最外层监听器的返回值就是最终请求配置。Web 入口会给每个 agent 装 `installModelSelection`，它把会话里存的 effort 重新盖到请求上。

本插件用 `prepend: true` 注册，因此**永远是最外层**——但它的判定只作用于两种情况：请求上带着 `autoEffortId`，或请求上没有任何 effort 且 `autoWhenUnset: true`。**请求上带着 `off`/`low`/`high`/`max` 时直接原样返回**，所以手动档位不会被覆盖。

`autoWhenUnset: false` 时，"没选档位"= 交给 provider 默认，插件也不出手。

---

## Auto 档位是怎么加进去的

选择器的列表来自 `ctx.llm.resolveModelInfo(...).reasoning.efforts`，而选中后 `selectModel` 会用 `resolveCallConfig` 校验这个 effort 是不是 adapter 声明过的。DSH 没有给"第三方增加档位"留扩展点（`registerAdapter` 对已注册的 provider 直接抛 `DUPLICATE_ADAPTER`），所以插件只包了 `llm` 服务实例上的三个方法：

| 包住的方法 | 作用 |
|---|---|
| `resolveModelInfo` | 在 adapter 自己声明的档位前面插入 `Auto`，并把它设为 advertised default（这样没显式选档位时选择器显示 Auto）。 |
| `resolveCallConfig` | 只对 `Auto` 这个 id 直接放行（它不是 adapter 的档位，选择阶段的校验要能过）。 |
| `agentDefaultModel.saveSelection` | 落盘全局默认时把 `Auto` 去掉，存成"没有显式档位"。 |

**`prepareCall` 故意不包**：万一 Auto 漏到了那一步（比如插件被卸载而某个会话还选着 Auto），adapter 边界会直接报 `UNSUPPORTED_REASONING_EFFORT`——一个会话内的显式报错，而不是一个发给 provider 的畸形请求。

---

## 请求路径上的边界

- **不支持的档位会被钳制**：插件先查 `ctx.llm.resolveModelInfo(provider, model)` 拿到该**精确模型**声明的 effort 列表（并滤掉 Auto），再在阶梯上取最近的一档（同距时偏向更强的一档）。DeepSeek 声明四档时通常不需要钳制；换 provider 也能用。
- **查不到能力就不动**：模型没声明 reasoning 能力、没有挂 `ctx.llm`、或查询失败时，请求原样返回（若是 Auto，则把 effort 去掉回落到 provider 默认），并只警告一次。
- **同一轮内档位一致**：同一 turn 的所有 step（包括只带 tool result 的 step）都用这一轮的档位；换轮才重新判定。
- **不碰 compaction / 会话标题**：那些请求不走 `agent/request`，不受影响（它们读的是**已落盘**的请求头，里面已经是替换后的真实档位）。

---

## 验证状态（诚实版）

**真机验证**（本机 v24.16.0 / DSH 0.1.2-rc.1 / `deepseek-official`，session 目录 `~/.dsh/sessions`）：

| 场景 | 怎么做的 | 结果 | 证据 |
|---|---|---|---|
| 挂载与配置合并 | `dsh plugin --profile headless add <path>` → `--dump-config` | 插件行与 config 正确出现 | `dsh --profile headless --dump-config` |
| 真机一轮（客套） | `dsh --profile headless "谢谢"` | `request/header` 里 `reasoningEffort: "off"` | `session-8ad972fc` |
| **对照组**（插件关掉） | 同一句话 + `--patch` 覆盖 `enabled: false` | `reasoningEffort: "high"`（= settings 默认） | `session-5d10f7f5` |
| 真机一轮（明确要深想） | `dsh --profile headless "深入思考一下：…"` | `reasoningEffort: "max"` | `session-779daed0` |
| 真机一轮（因果分析，未 pin） | `dsh --profile headless "Why does the upload helper return undefined after the migration?"` | `reasoningEffort: "high"`（why +5、migration +4 = 9，仍在 `high` 带内） | `session-30b39b2a` |
| **GUI：Auto 档位出现在选择器里** | 用**真实 web profile**（含 dshmarket/dsh-memories 等）另起一个 `dsh --profile web --port 0` 实例，浏览器打开 | 菜单变成 `Auto / Off / Low / High / Max`，选中后按钮显示"推理等级 Auto" | 服务 `127.0.0.1:3745` |
| **GUI：Auto → 每轮自动** | 选 Auto，发"谢谢" | 会话 `model/selection` 记 `reasoningEffort: "auto"`；请求头 `"off"` | `session-11eeae50` |
| **GUI：手动档位不被覆盖** | 同一会话改选 `Low`，发"深入思考一下：…"（本会判 `max`） | 请求头仍是 `"low"` —— 同一会话内两轮档位不同 | `session-11eeae50` |
| **GUI：Auto 不污染全局默认** | 选 Auto 后看 `settings.yaml` | `agent-default-model` 里**没有** `reasoningEffort`（存成"无显式档位"） | `~/.dsh/settings.yaml` |
| 真机：下限生效 | `dsh --profile headless "git status"` | `reasoningEffort: "low"`（不再降到 `off`） | `session-4987185c` |
| 真机：pin 越过天花板 | `dsh --profile headless "深入思考一下：…"` | `reasoningEffort: "max"` | `session-a82f0524` |
| 真机：天花板挡住高分 | 无 pin 的重负载长文本（why+codebase+deadlock+analyze+prove+design+migration…） | `reasoningEffort: "high"`（分数够 `max` 但被天花板拦住） | `session-771ee9b3` |

**只在进程内验证**（`tests/wiring.spec.ts` / `tests/capability.spec.ts`，用的是真的 cordis Context、真的 `installModelSelection`、真的 waterfall 分发器，且**故意让 selection 监听器先注册**）：

| 场景 | 说明 |
|---|---|
| Auto 档位注入 / 选择校验 / 落盘剥离 | `tests/capability.spec.ts`（含 dispose 恢复、幂等、无 llm 服务时降级） |
| Auto 在没有分类结果时也要落成真实档位 | `tests/wiring.spec.ts`：`reasoningEffort` 永远不是 `auto` |
| 钳制 / 查不到能力 / 无共享档位 | 用假 `llm` 服务覆盖 |
| 轮内 steering 只升不降、裸接续继承、跨轮不串档 | 见 `tests/state.spec.ts`、`tests/wiring.spec.ts` |

**没有真机验证的**（已知缺口，不要当成已验证）：

- **真实子代理会话**的跳过行为（`applyToSubagents: false`）：只在进程内用假 session header 测过。
- **非 DeepSeek provider** 的钳制路径：只用假 `resolveModelInfo` 测过。
- **插件卸载后仍有会话选着 Auto**：预期表现是会话内显式报 `UNSUPPORTED_REASONING_EFFORT`（`prepareCall` 故意不包），但没有真机跑过。

复现真机结果：

```powershell
# 找到最新 session 目录后
node scripts/inspect-session.mjs "C:\Users\Cooper\.dsh\sessions\--C-...--\session-<id>"
# 或直接筛出所有带 reasoningEffort 的请求头
node scripts/inspect-session.mjs <session-dir> --grep "request/header"
```

> `session.jsonl.zstd` 是**多帧** zstd（每个 flush 一帧），`zstdDecompressSync` 读整文件只会解出第一帧。`scripts/inspect-session.mjs` 会逐帧解。

---

## 开发

```powershell
pnpm install
pnpm check     # typecheck → lint → build → test（= CI 门禁）
```

- `lib/` 是构建产物，**不入库**。
- 仓库结构：`src/config.ts`（schema + fail-loud 校验）、`src/levels.ts`（分数带 + 钳制）、`src/signals.ts`（规则表 + 编译）、`src/classify.ts`（纯分类器）、`src/state.ts`（每 agent 的轮状态）、`src/capability.ts`（Auto 档位注入）、`src/index.ts`（接线）。
- 交接/背景见 `docs/handoff.md`，设计取舍见 `docs/design.md`。

## License

MIT
