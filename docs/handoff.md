# 交接文档 — dsh-auto-thinking-effort

> **给接手的人（或下一个会话的 agent）**：本文件是自包含的。你不需要之前的对话记录。
> 最后更新：2026-09-09。`pnpm check` 全绿（77 测试），真机验证见 §5。

---

## 0. 一句话现状

插件 **v0.4.0**：在选择器里加了一个 **Auto** 档位，选中后每轮自动切 effort；手动档位（off/low/high/max）原样保留、插件不插手。
分类有**两个后端**：默认纯启发式（零调用），`classifier: model` 时改用一次小模型调用（有超时、失败回落、pin 优先）。
边界借鉴 oh-my-pi：**默认不低于 `low`、分数算出来的档位不超过 `high`（只有显式 pin 到 `max`）、pin 只在正文匹配、钳制从下限一侧回答**（见 `docs/design.md` D13–D17）。
已单测（116 个）、已真机验证（含真实 web profile 的 GUI 与模型分类的 A/B）、已装进本机 `headless` 与 `web` 两个 profile。**未发布到 npm**。

代码提交见 `git log`；GitHub: https://github.com/CooperZhuang/dsh-auto-thinking-effort

**当前用户设置状态**：`~/.dsh/settings.yaml` 的 `agent-default-model` 现在是 `deepseek-v4.1-flash-expires-on-0910` + **`reasoningEffort: high`**（用户在 GUI 里手动选了 High），所以**新会话现在走手动档**、插件不介入。想让新会话回到 Auto：在 GUI 里选一次 Auto（插件会把 effort 从落盘值里剥掉，见 D12），或删掉 settings.yaml 里那一行。
---

## 1. 这个项目要做什么

DSH 插件：**根据用户这一轮的提问自动选择模型的思考档位**，但**必须让手动档位说了算**。

流程：插件往 `ctx.llm.resolveModelInfo()` 的能力列表里注入合成档位 `auto` →
用户在 GUI 选 Auto → `agent/pre-step` 读用户消息打分选档位 → `agent/request` 把 `auto` 换成模型真正支持的 effort。

**不做什么**：默认不调模型分类（可选开启）、不改模型/provider/prompt、不管子代理（默认）、不碰 compaction 与会话标题请求。

---

## 2. 仓库与环境事实

| 项 | 值 |
|---|---|
| GitHub | https://github.com/CooperZhuang/dsh-auto-thinking-effort （public） |
| 本地 | `C:\CodeRepository\dsh-auto-thinking-effort` |
| 包名 / 版本 | `dsh-auto-thinking-effort` / `0.4.0`（**未发布**） |
| Node / pnpm | v24.16.0 / 12.3.4（`packageManager` 已钉） |
| DSH 依赖 | **`0.1.2-rc.1`**（npm `next` dist-tag，不是 `latest`） |
| DSH CLI | `C:\Users\Cooper\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` |
| 已装 profile | `headless`（验证用，`dsh-base`+`dsh-headless`+本插件）、**`web`**（用户日常，末尾追加本插件） |
| 用户设置 | `C:\Users\Cooper\.dsh\settings.yaml` |
| 会话日志 | `C:\Users\Cooper\.dsh\sessions\<slug>\session-<id>\session.jsonl.zstd` |

---

## 3. 代码地图

| 文件 | 内容 |
|---|---|
| `src/capability.ts` | **Auto 档位注入**：包 `resolveModelInfo`（插入 auto + 设为 advertised default）、`resolveCallConfig`（放行 auto）、`agentDefaultModel.saveSelection`（落盘剥掉 auto）；`withAutoGear` / `requestsAutoGear` / `routeOffersEfforts` 纯函数 |
| `src/config.ts` | schemastery schema + `resolveConfig`（输入可省略）+ `prepareConfig`（校验 + 编译规则 + 解析 `$strongest`/`$weakest`） |
| `src/levels.ts` | `DEFAULT_LEVELS` 分数带、`assertLevels`、`levelForScore`、`effortLadder`、`resolveEffort`（**下限池 + 取不超过请求的最高档**） |
| `src/signals.ts` | `BUILTIN_RULES`（pin + 加权，中英双语）、`compileRules`（拒绝 `g`/`y`，pin 默认 `proseOnly`） |
| `src/classify.ts` | `classify`（pin → 加权 → 结构特征 → 分数带 → 裸接续继承 → **天花板**）、`stripNonProse`、`truncateForClassification` |
| `src/state.ts` | `AgentState`：轮状态、steering 只升不降、`forTurn` 只认同一轮 |
| `src/model-classifier.ts` | **可选模型分类后端**：`buildClassifierPrompt`（用阶梯的 id+description 生成提示）、`parseClassifierAnswer`（取最早出现的档位词）、`runModelClassifier`（`ctx.llm.stream` + 超时 + 四种失败都返回 undefined） |
| `src/index.ts` | 接线：Auto 注入、`agent/pre-step`（只读；子代理默认跳过；**在这里发起模型分类**）、`agent/request`（`prepend: true`；auto→真实档位；具体档位原样返回；**在这里 await 分类结果**；disabled 时只做兜底改写） |
| `scripts/inspect-session.mjs` | 逐帧解 `session.jsonl.zstd` 并打印关键事件（**多帧！**） |

---

## 4. 关键 DSH API（含证据位置）

| 用途 | API / 事实 | 位置 |
|---|---|---|
| 请求改写缝 | `agent/request` waterfall，`await next()` 得到 loop 的 seed config，返回替换值 | `dsh-agent/lib/types/runtime-types.d.ts:246-263` |
| waterfall 顺序 | 最外层监听器的返回值 = 最终值；`prepend` → `unshift` → 最外层 | `cordis/src/events.ts:225-243,254-260` |
| 会被谁盖掉 | `installModelSelection` 在 agent ctx 上重设 provider/model/effort | `dsh-agent/lib/types/model-selection.js:33-47` |
| 选择器的档位列表 | `buildModelCatalog` 从 `ctx.llm.resolveModelInfo(...).reasoning.efforts` 生成 | `dsh-api-session-controller/lib/types/catalog.js:14-26` |
| 选择校验 | `selectModel` → `ctx.llm.resolveCallConfig(...)`，未声明的 effort 抛 `UNSUPPORTED_REASONING_EFFORT` | `dsh-api-session-controller/lib/types/commands.js:122-155`；`dsh-llm/lib/index.js:1561-1586` |
| 会话选择的真相来源 | `current` getter：优先 `picked`，否则用**已落盘的请求头**反推；`consume` 只在 effort 完全相等时清掉 `picked` | `dsh-api-session-controller/lib/types/agent.js:289-345` |
| 不能包 adapter | `registerAdapter` 对已注册 provider 抛 `DUPLICATE_ADAPTER` | `dsh-llm/lib/index.js:1242-1272` |
| 服务实例可打补丁 | `ctx.llm` 返回的 traceable proxy 的 `set` 会落到真实实例上（已用探针验证） | `.verify/cordis-patch-probe*.mjs` |
| 请求头记账 | config 变了才追加 `request/header`（reason=change） | `dsh-agent-loop/lib/index.js:700-756` |
| 子代理标记 | `session.header.origin === 'subagent'` | `dsh-session/lib/types/types.d.ts:79-83` |
| bundle 不热加载 | `patchReload: live` 只监听 profile 的 `cordis.patch.yml` | `dsh-app-boot/lib/index.js:1075-1095` |
| 分类调用的旁路 | 直接 `ctx.llm.stream(options)`，不带 `purpose`，因此**不经过 `agent/request`**；`GenerateOptions.purpose` 只认 `'compaction'` / `'session-title'` | `dsh-llm/lib/types/types.d.ts:379-416` |
| 验证时隔离设置 | `settings-file` 插件行有 `path` 配置（默认是 harness home 下的 `settings.yaml`），可用 `--patch` 指向临时设置文件 | `dsh-settings-file/lib/types/index.d.ts:12-20` |

---

## 5. 验证状态（诚实版）

**真机验证**（Node v24.16.0 / DSH 0.1.2-rc.1 / `deepseek-official`）：

| 场景 | 做法 | 结果 | 证据 |
|---|---|---|---|
| 挂载 + 配置合并 | `dsh plugin --profile headless add <path>` → `--dump-config` | 行与 config 正确 | `dsh --profile headless --dump-config` |
| 真机一轮（客套） | `dsh --profile headless "谢谢"` | `reasoningEffort: "off"` | `session-8ad972fc` |
| **对照组**（关插件） | 同句 + `--patch` 覆盖 `enabled: false` | `"high"` | `session-5d10f7f5` |
| 真机一轮（要求深想） | `dsh --profile headless "深入思考一下：…"` | `"max"` | `session-779daed0` |
| 真机一轮（因果分析，未 pin） | `dsh --profile headless "Why does the upload helper return undefined after the migration?"` | `"high"`（why+5、migration+4） | `session-30b39b2a` |
| **GUI：Auto 出现在选择器** | 用**真实 web profile** 另起 `dsh --profile web --port 0`（`127.0.0.1:3745`），浏览器打开 | 菜单 `Auto / Off / Low / High / Max`；选中后显示"推理等级 Auto" | 服务 3745 |
| **GUI：Auto → 每轮自动** | 选 Auto，发"谢谢" | `model/selection` 记 `reasoningEffort:"auto"`；请求头 `"off"` | `session-11eeae50` |
| **GUI：手动档位不被覆盖** | 同会话改选 `Low`，发"深入思考一下：…"（本会判 max） | 请求头仍是 `"low"` —— **同一会话两条不同 header** | `session-11eeae50` |
| **GUI：Auto 不污染全局默认** | 选 Auto 后看 `settings.yaml` | `agent-default-model` 无 `reasoningEffort` | `~/.dsh/settings.yaml` |
| 真机：下限生效（v0.3） | `dsh --profile headless "git status"` | `"low"`（v0.2 是 `off`） | `session-4987185c` |
| 真机：pin 越过天花板（v0.3） | `dsh --profile headless "深入思考一下：…"` | `"max"` | `session-a82f0524` |
| 真机：天花板挡住高分（v0.3） | 无 pin 的重负载长文本 | `"high"` | `session-771ee9b3` |
| 真机：模型分类后端生效（v0.4） | 同一句话分别 `classifier: heuristic` / `classifier: model`（`deepseek-v4-flash`） | `high` → `low`（模型判断 trivial 并覆盖启发式） | `session-81e78e99` / `session-7de3b60c` |
| 真机：分类器失败不破坏这一轮（v0.4） | `classifierModel` 指向不存在的模型 | 请求照常发出，回落到启发式 `high` | `session-718b1f73` |

> 这两次比对用 `--patch` 把 `settings-file` 指向 `.verify/settings-verify.yaml`（临时设置，默认档位不带 effort），否则用户当前的 `reasoningEffort: high` 会让会话走手动档、插件根本不介入。

**只在进程内验证**（`tests/wiring.spec.ts` / `tests/capability.spec.ts` / `tests/model-classifier.spec.ts`：真 cordis Context + 真 `installModelSelection` + 真 waterfall，且**故意先注册 selection**）：

- Auto 注入 / 放行 / 落盘剥离 / dispose 恢复 / 幂等 / 无 llm 服务降级
- Auto 在没有分类结果时也必须落成真实档位（绝不把 `auto` 写进请求）
- 钳制 / 查不到能力 / 无共享档位
- 轮内 steering 只升不降、裸接续继承、跨轮不串档、手动档位原样返回
- 模型分类：pin 时不调用、候选集只含 floor..ceiling、答案解析（含「最早出现」「不匹配更长单词」）、超时与四种失败都回落、缓存命中

**未真机验证（已知缺口）**：

- 真实子代理会话的跳过行为（`applyToSubagents: false`）
- 非 DeepSeek provider 的钳制路径
- 卸载插件后仍有会话选着 Auto（预期会话内报 `UNSUPPORTED_REASONING_EFFORT`，因为 `prepareCall` 故意不包）

复现：

```powershell
node scripts\inspect-session.mjs "C:\Users\Cooper\.dsh\sessions\--C-CodeRepository-dsh-auto-thinking-effort--\session-8ad972fc-e503-4fde-b78a-73c4264c1c8f"
node scripts\inspect-session.mjs <session-dir> --grep "request/header"
```

---

## 6. 陷阱清单（都是踩过的）

1. **`@deepseek-ai/dsh-*` 的 npm `latest` 是旧的 `0.0.1-rc.x`**；正确版本在 `next` = `0.1.2-rc.1`。装依赖必须钉版本。
2. **schemastery 的 `.default()` 参数必须能赋给 schema 的**输出**类型**：`levels` 里 `maxScore` 用 `z.number().required(false)` 时输出类型仍是 `number`，所以默认值不能是"缺字段的对象数组"——改成 `.default([])`，把"空 = 默认阶梯"交给 `prepareConfig`。
3. **`Config` 是"可调用 schema"**（`Config(raw)`），没有 `.parse`；输入类型被声明成输出类型，传部分对象要经过 `resolveConfig`。
4. **`session.jsonl.zstd` 是多帧 zstd**（每个 flush 一帧）：`zstdDecompressSync` 读整文件只解第一帧。用 `scripts/inspect-session.mjs`。
5. **`ctx.llm.resolveModelInfo()` 是 async**，且失败/未挂 llm 都要降级成"不改请求"。
6. **`playwright-cli` 的 `default` 浏览器是跨会话共享的**：另一个 agent 会话（或用户）已经打开过它时，`open <url>` 可能"成功"但当前页面属于**另一个** `dsh web` 服务器。2026-09-09 就发生过。**动手前必须确认页面 URL / 端口**（快照里的 `Page URL`，或 `Get-NetTCPConnection -LocalPort <port>`），事后可用会话日志里 "Web GUI at http://127.0.0.1:<port>" 反查是哪个服务在服务它。也不要 `close` 共享浏览器。
7. **headless 是一次性任务**，没有多轮入口；多轮要 `dsh web`（默认端口可能被占用，用 `--port 0`）。
8. **`dsh plugin --profile <name> add <相对路径>`** 以 profile 目录为基准解析，必须传**绝对路径**。
9. **自定义 profile 名只会初始化成 `[dsh-base]`**：要 web 行为得手动把 `@deepseek-ai/dsh-web-app` 加进 `dsh.profile.bundles`（in-box bundle 从全局安装解析）。
10. **改 bundle 不热加载**：装/卸插件要重启 `dsh web` 才生效（`patchReload: live` 只管 `cordis.patch.yml`）。
11. **GUI 里选档位会写全局默认**：`selectModel` 末尾会 `agentDefaultModel.saveSelection(...)`。这正是 D12 那道守卫存在的原因——**别删**。

---

## 7. 下一步（按优先级）

1. **U2 真实子代理**：跑一次 `subagent` 调用，确认子会话的 `request/header` 未被改写；再开 `applyToSubagents: true` 对比。
2. **U3 非 DeepSeek provider**：接一个声明 3 档或 5 档的 provider，验证钳制。
3. **发布**：`pnpm publish`（`prepublishOnly` 会构建）；发布后把 README 的安装命令改成包名优先。
4. **U6 卸载安全**：现在卸载后选着 Auto 的会话会报错。可选方案：给 profile 加一条 `cordis.patch.yml` 兜底行（把 `auto` 映射到 provider 默认），或做一个"插件缺失时自动降级"的 companion。
5. 可选：给 GUI 加"本轮档位"只读显示（需要 client 插件，目前是 host 单半）。

---

## 8. 命令速查

```powershell
# 开发门禁（= CI）
cd C:\CodeRepository\dsh-auto-thinking-effort
pnpm install ; pnpm check      # typecheck → lint → build → test

# 看 DSH 源码（只读）
#   实现： C:\Users\Cooper\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<pkg>\
#   组合： dsh-base\cordis.patch.yml、dsh-web-app\cordis.patch.yml、dsh-agent-presets\presets\standard\agent.cordis.yml

# 挂载 / 卸载（装完要重启 dsh web）
dsh plugin --profile web add C:\CodeRepository\dsh-auto-thinking-effort
dsh plugin --profile web remove dsh-auto-thinking-effort

# 真机跑一轮（会真的调模型，注意费用）
dsh --profile headless "谢谢"
dsh --profile headless "深入思考一下：为什么…"

# 只看判定不改请求：加 --patch 覆盖 dryRun: true（模板见 .verify/）
```

---

## 9. 交接清单

- [x] 代码 + 单测（116 个）+ CI workflow
- [x] Auto 档位注入（D10）与「手动优先」（D11）与全局默认守卫（D12）
- [x] 边界策略对齐 oh-my-pi（D13 下限 / D14 上限 / D15 pin 只在正文 / D16 钳制方向）
- [x] **可选模型分类后端**（D17）：`classifier: heuristic|model`，真机 A/B 验证
- [x] 真机挂载与请求头证据（含对照组）
- [x] **GUI 真机验证**：Auto 出现并可选中、每轮自动、手动不被覆盖、默认不被污染
- [x] v0.3 / v0.4 真机证据（下限 / pin 越天花板 / 天花板挡高分 / 模型分类 A/B / 分类失败回落）
- [x] 装进用户的 `web` profile（bundle 已追加；重启后生效）
- [x] 设计决策与证据位置（`docs/design.md` D1–D17）
- [x] 中英 README，含「真机验证 / 仅单测 / 未验证」三张表 + oh-my-pi 对比表
- [ ] 真实子代理跳过验证（U2）
- [ ] 发布到 npm
