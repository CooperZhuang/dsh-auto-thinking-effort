# dsh-auto-thinking-effort

> DSH（DeepSeek Harness）插件：**根据用户这一轮的提问，自动选择模型的思考档位（reasoning effort）**。
>
> 问"谢谢"→ 关掉思考；问"为什么这里会死锁，分析并证明"→ 拉到最高档。
>
> [English README →](./README_EN.md)

---

## 它做什么（以及不做什么）

每一轮（turn）开始前，插件读一遍**用户自己写的消息**，算一个分数，把分数映射到**档位阶梯**，再在请求组装的那一刻只改写一个字段：`reasoningEffort`。

- **只改 `reasoningEffort`**。provider、model、system prompt、消息列表一律不动。最坏情况是"这轮想得多了/少了"，永远不会变成"另一段对话"。
- **不调模型做分类**。分类是纯函数（正则 + 结构特征），零延迟、零成本、可单测、可复现。代价是它读的是**形状和用词**，不是语义——所以默认档位是 provider 的常规档，而不是最便宜的档。
- **不改用户的手动选择？** 默认会改。见下面 [优先级](#优先级会覆盖-gui-里的档位选择)。

---

## 安装

```powershell
# 本地 checkout（当前状态：尚未发布到 npm，用这一种）
dsh plugin --profile headless add C:\CodeRepository\dsh-auto-thinking-effort

# 发布后可以直接按包名装（插件行会随 bundle patch 自动挂载）
dsh plugin --profile headless add dsh-auto-thinking-effort
```

装完 `dsh --profile headless --dump-config` 里应能看到：

```yaml
- id: auto-thinking-effort
  name: dsh-auto-thinking-effort
  config:
    enabled: true
    dryRun: false
    applyToSubagents: false
    respectExplicitEffort: false
```

想先看它**打算**怎么判、但先不改请求：把 `dryRun: true` 打开，日志里会打出每轮的档位与理由。

---

## 档位阶梯

默认阶梯对齐 DeepSeek 的四个档（`off` / `low` / `high` / `max`）。`maxScore` 是**该档的分数上界（含）**，最后一档必须不写上界（兜底）。

| 档位 id | 请求的 effort | 分数区间 | 含义 |
|---|---|---|---|
| `minimal` | `off` | ≤ −6 | 客套、纯机械操作 |
| `low` | `low` | −5 … −2 | 简单但要认真回答一句 |
| `high` | `high` | −1 … 11 | **默认带**：普通提问、日常编码 |
| `max` | `max` | ≥ 12 或用户明确要求 | 多信号叠加的硬任务 |

分数 0（没有任何信号）落在 `high`——刻意如此：猜错方向时，"多想一点"比"少想一点"安全。

### 什么在加减分

**强制档（pin，直接短路，不做加权）**

| 触发 | 档位 |
|---|---|
| `think hard` / `深入思考` / `仔细分析` / `thoroughly analyze` / `max thinking` | 最强档 |
| `quick` / `简单说` / `一句话` / `不用想` / `直接给` | 最弱档 |

> pin 用的是 `$strongest` / `$weakest` 令牌，所以你把阶梯换成三档、五档，这两条规则照样有效。

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
| 客套：`谢谢` / `好的` / `thanks` | −4 |

**结构特征（代码算出来的，不用写正则）**

| 特征 | 权重 |
|---|---|
| 正文 ≥ 2000 / 600 / 200 字符 | +4 / +2 / +1 |
| 2 个以上代码块 / 1 个代码块 | +3 / +2 |
| 3 个以上问号 / 2 个问号 | +2 / +1 |
| 3 行以上列表项 | +1 |
| ≤ 24 字符且无代码块 | −3 |

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
        respectExplicitEffort: false
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
| `enabled` | `true` | 总开关。关闭时不注册任何监听器。 |
| `dryRun` | `false` | 只判定 + 打日志，**不**改写请求。 |
| `levels` | 见上表 | 分数→档位→effort 的阶梯；空列表 = 用默认阶梯。 |
| `builtinRules` | `true` | 是否启用内置规则（关掉只用自己的 `rules`）。 |
| `rules` | `[]` | 追加规则；`level` 是 pin，`weight` 是加减分。 |
| `inheritOnContinuation` | `true` | 裸接续是否继承上一轮档位。 |
| `applyToSubagents` | `false` | 是否也管子代理会话（子代理通常由调用方指定路线，默认不动）。 |
| `respectExplicitEffort` | `false` | 请求上已有显式 effort 时是否让位（见下）。 |
| `logDecisions` | `true` | 每轮打一行 info 日志：档位、分数、理由。 |
| `maxChars` | `8000` | 分类时最多看多少字符（超长会保留头 60% + 尾 40%）。 |

### 规则写法

- `pattern`：正则源码，默认大小写不敏感（`flags: 'i'`）。**禁止 `g` / `y`**——它们会让 `lastIndex` 有状态，同一个函数对不同调用给出不同答案。
- `level`：pin 到某个档位 id，或 `$strongest` / `$weakest`。
- `weight`：加权分数，可为负。
- `note`：日志与决策记录里的理由。

加载期就会 fail loud：正则编不过、`level` 指向不存在的档位、`maxScore` 不递增、`maxChars` 非法……都会直接抛错，而不是等到第一轮才悄悄失效。

---

## 优先级：会覆盖 GUI 里的档位选择

`agent/request` 是一条 **waterfall**：最外层监听器的返回值就是最终请求配置。Web 入口会给每个 agent 装 `installModelSelection`，它会把会话里存的 effort（来自 `settings.yaml` 的 `agent-default-model.reasoningEffort`，或 GUI 模型选择器）重新盖到请求上。

本插件用 `prepend: true` 注册，因此**永远是外层**，判定结果会覆盖那个存储值。

- 想让 GUI / settings 的档位说了算：设 `respectExplicitEffort: true`（此时请求上已有显式 effort 就完全不动）。
- 想临时整体关掉：`enabled: false` 或 `dryRun: true`。

---

## 请求路径上的边界

- **不支持的档位会被钳制**：插件先查 `ctx.llm.resolveModelInfo(provider, model)` 拿到该**精确模型**声明的 effort 列表，再在阶梯上取最近的一档（同距时偏向更强的一档）。DeepSeek 声明四档时通常不需要钳制；换 provider 也能用。
- **查不到能力就不动**：模型没声明 reasoning 能力、没有挂 `ctx.llm`、或查询失败时，请求原样返回，并只警告一次。
- **同一轮内档位一致**：同一 turn 的所有 step（包括只带 tool result 的 step）都用这一轮的档位；换轮才重新判定。
- **不碰 compaction / 会话标题**：那些请求不走 `agent/request`，不受影响。

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
| **GUI 真机一轮** | 临时 `web-verify` profile（`dsh-base` + `dsh-web-app` + 本插件）在 `127.0.0.1:5227`，浏览器里发"谢谢" | `reasoningEffort: "off"` —— 尽管 settings 里默认是 `high`，且该 profile 装有 `installModelSelection` | `session-76a1f832` |

**只在进程内验证**（`tests/wiring.spec.ts`，用的是真的 cordis Context、真的 `installModelSelection`、真的 waterfall 分发器，且**故意让 selection 监听器先注册**）：

| 场景 | 说明 |
|---|---|
| 覆盖存储档位 | 第一个用例：没有 `prepend` 就会挂 |
| 钳制 / 查不到能力 / 无共享档位 | 用假 `llm` 服务覆盖 |
| 轮内 steering 只升不降、裸接续继承、跨轮不串档 | 见 `tests/state.spec.ts`、`tests/wiring.spec.ts` |

**没有真机验证的**（已知缺口，不要当成已验证）：

- **同一会话内的跨轮切换**（turn 1 `max` → turn 2 `off` 触发 `request/header` reason=change）：headless 是一次性任务，没有多轮入口；只在进程内测过。
- **真实子代理会话**的跳过行为（`applyToSubagents: false`）：只在进程内用假 session header 测过。
- **非 DeepSeek provider** 的钳制路径：只用假 `resolveModelInfo` 测过。

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
- 仓库结构：`src/config.ts`（schema + fail-loud 校验）、`src/levels.ts`（分数带 + 钳制）、`src/signals.ts`（规则表 + 编译）、`src/classify.ts`（纯分类器）、`src/state.ts`（每 agent 的轮状态）、`src/index.ts`（接线）。
- 交接/背景见 `docs/handoff.md`，设计取舍见 `docs/design.md`。

## License

MIT
