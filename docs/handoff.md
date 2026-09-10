# 交接文档 — dsh-auto-thinking-effort

> **给接手的人（或下一个会话的 agent）**：本文件是自包含的。你不需要之前的对话记录。
> 最后更新：2026-09-10。`pnpm check` 全绿（123 测试），真机验证见 §5。

---

## 0. 一句话现状

插件 **v0.6.0**：在选择器里加了一个 **Auto** 档位，选中后每轮自动切 effort；手动档位（off/low/high/max）原样保留、插件不插手。
分类有**两个后端**，**默认是 `model`**（一次小模型调用；有超时、失败回落、pin 优先），`heuristic` 是随时可切回的零调用路径（D20）。
边界可配：**下限默认不设（可以到 `off`）**、**分数算出来的档位不超过 `high`（只有显式 pin 到 `max`）**、pin 只在正文匹配、钳制从下限一侧回答（见 `docs/design.md` D13–D17）。
v0.6 新增：① 插件注册了一个 settings 命名空间 `auto-thinking-effort`，**profile 行是 base 层、`~/.dsh/settings.yaml` 同名段是用户层（优先且热生效）** —— 改完不用重启 `dsh web`（D18）；② 包**自带了浏览器半边**：**设置 → 自动思考强度**是一整页独立配置（左侧导航里排在「模型」之后、「插件」之前），**「设置 → 插件 → 插件配置」里不再有本插件的卡片**（用户要求：有了独立一页就不要重复出现）；`classifierModel` 是从本机模型目录来的下拉框（D19/D20）。
已单测（123 个）、已真机验证（用户真实 web profile + 干净 scratch profile：导航出现、表单渲染、模型下拉、保存写入、host 采纳、重置、插件列表不再重复）、已装进本机 `headless` 与 `web` 两个 profile。**未发布到 npm**。
代码提交见 `git log`；GitHub: https://github.com/CooperZhuang/dsh-auto-thinking-effort

**当前用户设置状态**：`~/.dsh/settings.yaml` 的 `agent-default-model` **没有** `reasoningEffort`（= 新会话默认 Auto，见 D12）。同文件的 `auto-thinking-effort:` 段写了 `classifier: model` + `classifierModel: deepseek-official/deepseek-v4-flash` + `autoFloorLevel: minimal` + `autoCeilingLevel: high`；`web` profile 的 `cordis.patch.yml` 里那条 `auto-thinking-effort` 覆盖行（同样把分类后端设成 model）**保留作为 base 层**，兼顾旧版本。注意：用户当前跑着的 `dsh web` **还需要再重启一次**才会加载浏览器半边（bundle 与客户端 bundle 都不热加载；重启后左侧导航就会出现「自动思考强度」）。**⚠ 重启前先看 §6 陷阱 14：用户 `web` profile 里有一个第三方客户端插件会让整个客户端 boot 失败。**
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
| 包名 / 版本 | `dsh-auto-thinking-effort` / `0.6.0`（**未发布**） |
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
| `src/index.ts` | 接线：Auto 注入、`agent/pre-step`（只读；子代理默认跳过；**在这里发起模型分类**）、`agent/request`（`prepend: true`；auto→真实档位；具体档位原样返回；**在这里 await 分类结果**；disabled 时只做兜底改写）、**settings 命名空间**（`SETTINGS_NAMESPACE`、`ctx.inject(['settings'])` → `register`/`adopt`/`watch`，见 D18） |
| `src/client.js` | **浏览器半边**（唯一不经 tsc 的源码）：惰性 CJS client bundle，只向 `settings.section` 注册**一页设置**（id/ns `auto-thinking-effort`、label「自动思考强度」、order 12）；绑定 `ctx.settingsScope`，草稿→一次原子 `mutate`（revision 设栅），留空即 `unset`；`classifierModel` 用 `ctx.inject(['remote','remote.session'])` 读模型目录（见 D19/D20） |
| `scripts/build-client.mjs` | 把 `src/client.js` 拷成 `lib/client.js` 并校验 bundle 形状与 id（错了就构建失败） |
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
| 注册配置命名空间 | `ctx.settings.register(ns, schema, { base, applies: 'live', validate })` → `SettingsScope{ get, watch, update, replace }`；解析 = schema 默认 → `base` → 用户层；`validate` 抛错会**拒绝写入**并保留上一份 | `dsh-settings/lib/index.js:270-291`（register）、`:478-515`（publish/resolve）、`:238-251`（service init 时读文档） |
| 读服务要 inject | `ctx.get(name, strict=true)` 只返回**提供它的 fiber 已 active** 的服务（“without the inject requirement” 要走 `ctx.reflect`）；正确写法是 `ctx.inject(deps, cb)`（等价 `ctx.plugin({ inject, apply })`：服务出现时回调、替换时重跑、永不存在时永不执行） | `cordis/lib/index.js:762-769`；`cordis/lib/types/reflect.d.ts:5-13`；`cordis/lib/types/registry.d.ts:104-111`；DSH 自己的用法：`dsh-agent-default-model/lib/index.js:44`、`dsh-theme/lib/index.js:87` |
| 浏览器半边的交付形式 | 包在 `package.json` 里声明 `dsh.client`（`platform: 'web'`）并导出 `./client`；Host 扫描已启用的 Loader 条目、把每个 bundle 放在 `/plugins` 下、以 `window.__ModuleLoader__.load({id, factory})` 形注册；`id` = 解析出的包名；React / `dsh-client-ui-slots` 等由外壳的静态模块表播种，**不需要**写 `external`（`external` 只用于「另一个动态插件的 client 半边」） | `dsh-client-modules/README.zh.md`（“声明客户端插件/共享模块/构建要求”）、`lib/types/client/manifest.d.ts:41-58,147-156,186-190`；真机：启动图里 `{"id":"dsh-auto-thinking-effort","url":"/plugins/??dsh-auto-thinking-effort/client.js&rev=…"}` |
| 插件卡片扩展点（**本插件已不用**） | `ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name: 'settings.plugin.item', key: '<ns>' }, Component))`；分区只把**被服务且有人认领**的命名空间渲染出来。留在这里是因为它解释了「为什么光注册命名空间看不到入口」：没人认领的命名空间什么都不渲染 | `dsh-client-ui-settings-plugins/lib/types/client/slot-contract.d.ts`、`README.zh.md` |
| 设置页扩展点（**现在用的**） | `ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id, order, label }, Component))`；list slot，label 决定左侧导航文字，组件拿到 `{ close }` | 同上 + `dsh-cordis-client-runner/lib/client.js`（slot catalog 的 `example`/`registerOptions` 字段）；真机：导航多出「自动思考强度」 |
| 浏览器侧写设置 | `ctx.settingsScope.bind({ namespace })` → `{ getSnapshot, subscribe, set, unset, mutate(ops, expectedRevision) }`；快照带 `value/base/user/revision/writable/status`；写操作是 `SettingsPathOpView`（`{op:'set', path, value}` 或 `{op:'unset', path}`） | `dsh-client-ui-settings/lib/types/client/settings-contract.d.ts`、`settings-scope.d.ts`；`dsh-settings/lib/types/types.d.ts:51-61` |

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
| 真机：默认无下限（v0.5） | `dsh --profile headless "git status"`（真实 settings，Auto） | `"off"` | `session-3af16e67` |
| 真机：下限可收紧（v0.3 行为） | 同一句话 + `autoFloorLevel: low` | `"low"` | `session-4987185c` |
| 真机：pin 越过天花板（v0.3） | `dsh --profile headless "深入思考一下：…"` | `"max"` | `session-a82f0524` |
| 真机：天花板挡住高分（v0.3） | 无 pin 的重负载长文本 | `"high"` | `session-771ee9b3` |
| 真机：模型分类后端生效（v0.4） | 同一句话分别 `classifier: heuristic` / `classifier: model`（`deepseek-v4-flash`） | `high` → `low`（模型判断 trivial 并覆盖启发式） | `session-81e78e99` / `session-7de3b60c` |
| 真机：分类器失败不破坏这一轮（v0.4） | `classifierModel` 指向不存在的模型 | 请求照常发出，回落到启发式 `high` | `session-718b1f73` |
| **真机：settings 用户层在加载期被读到（v0.6）** | `--patch` 把 `settings-file` 指到 `.verify/settings-user-layer.yaml`（只有用户层写 `autoFloorLevel: low`，base 行仍是 `minimal`），跑 `dsh --profile headless "git status"` | `"low"`（base 单独跑同句是 `"off"`） | `session-518c09e2` vs `session-3af16e67` |
| **真机：跑着的 host 热重配（v0.6）** | 同一个 `dsh --profile web --port 0` 进程（PID 18604，10:03:40 启动，全程未重启），对同一句 `why does the whole codebase deadlock? prove the invariant.`：文件里先 `autoCeilingLevel: max`，改成 `high` 后再发一次，再改回 `max` 又发一次 | 同一进程内 `request/header` 随文件变化（provider 自己的默认是 `high`，因此 `max` 只可能来自插件） | `session-0f47f1c6`（high） / `session-b7f7a469`（max）；最终构建单点复核 `session-ce7ffac5`（max） |
| **真机：设置页里独立的一项（v0.6.0）** | 全新 `dsh --profile webverify`（`dsh-base` + `dsh-web-app` + 本插件，绕开当时坏掉的第三方客户端插件），打开「设置」 | 左侧导航出现「自动思考强度」（「模型」之后、「插件」之前），点开是完整表单；`classifier` 默认选中 `model` | `docs/design.md` D19/D20 |
| **真机：`classifierModel` 下拉（v0.6.0）** | 同一进程展开该字段，并选一个保存 | 选项 = 本机模型目录的 4 个模型 +「（跟随会话模型）」；保存后 `settings.yaml` 写入 `classifierModel: deepseek-official/deepseek-v4-flash` | 同一 scratch 设置文件 |
| **真机：热重配（v0.6，含设置页写入）** | 同上进程：表单里 `autoFloorLevel: low` 保存 → 新会话 `git status` | 文件写入 + `request/header` = `"low"`（base 单独跑同句是 `"off"`） | `session-b340648b` |
| **真机：设置页里「重置」= 清除覆盖（v0.6）** | 点该字段的「重置」再保存 | `settings.yaml` 里 `autoFloorLevel` 一行消失（重新继承 base 的 `minimal`） | 同一 scratch 设置文件 |
| **真机：插件列表不再重复出现（v0.6.0）** | 用户真实 `web` profile（第三方插件已修）打开「设置 → 插件 → 插件配置」 | 只剩官方卡片（插件市场 / 终端 …），本插件只以左侧独立一页存在 | 同一进程复核 |

> 这两次比对用 `--patch` 把 `settings-file` 指向 `.verify/settings-verify.yaml`（临时设置，默认档位不带 effort），否则用户当前的 `reasoningEffort: high` 会让会话走手动档、插件根本不介入。

**只在进程内验证**（`tests/wiring.spec.ts` / `tests/capability.spec.ts` / `tests/model-classifier.spec.ts`：真 cordis Context + 真 `installModelSelection` + 真 waterfall，且**故意先注册 selection**）：

- Auto 注入 / 放行 / 落盘剥离 / dispose 恢复 / 幂等 / 无 llm 服务降级
- Auto 在没有分类结果时也必须落成真实档位（绝不把 `auto` 写进请求）
- 钳制 / 查不到能力 / 无共享档位
- 轮内 steering 只升不降、裸接续继承、跨轮不串档、手动档位原样返回
- 模型分类：pin 时不调用、候选集只含 floor..ceiling、答案解析（含「最早出现」「不匹配更长单词」）、超时与四种失败都回落、缓存命中
- **settings 命名空间（6 个）**：注册参数（名字/base/`applies: 'live'`）、没挂 provider 时降级到 composition 行、用户层在加载期优先、watch 提交后重配（同一个 harness 里两次分类结果不同）、`enabled: false` 后不再广告档位但兜底仍生效、非法提交保留上一份配置。（harness 新增 `settle()`：注入回调不在 `apply` 的同步路径上。）

**没有任何自动化测试的部分**：浏览器半边（`src/client.js`）只有真机验证 —— 本仓库没有客户端测试运行时，也不该为此拉一个。所以它的回归网就是 D19/D20 那两张表和本文 §5 的真机步骤；改它之后**必须**手动跑一遍「导航出现 / 表单渲染 / 模型下拉 / 保存 / host 采纳 / 重置 / 插件列表不重复」这几步。

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
10. **改 bundle 不热加载**：装/卸插件要重启 `dsh web` 才生效（`patchReload: live` 只管 `cordis.patch.yml`）。**客户端 bundle 同理**：改了 `src/client.js` 后光刷新页面没用，要重新 `pnpm build` + 重启服务（页面刷新只重新拉 `/plugins/...` 的同一个 rev）。
11. **GUI 里选档位会写全局默认**：`selectModel` 末尾会 `agentDefaultModel.saveSelection(...)`。这正是 D12 那道守卫存在的原因——**别删**。
12. **cordis 里 `ctx.get(name)` 读不到“fiber 还没 active”的服务**（而 DSH 的 settings provider 正是异步读完文档的）；要用 `ctx.inject([...], cb)`。第一版用 `ctx.get('settings')` 真机**静默失效**：用户层写了 `autoFloorLevel: low`，跑出来还是 `off`，唯一线索是“把一个非法值写进去也不报错”（如果真注册了，`validate` 会当场拒统）。排查手法记一下：**拿一个必然非法的值去戳，看有没有声音**。
13. **手改 `~/.dsh/settings.yaml` 时别把下一段的 key 吃掉**：这次差点把 `dsh-better-sidebar:` 这行删成注释，结果整个 sidebar 的键被归到本插件命名空间下。改完用真 yaml 解析器验一下（`yaml.parseDocument(...).errors` + 打印 section 名），因为 settings provider 只会觉得“这一段多了一些键”。
14. **一个坏的第三方客户端插件会让整个 GUI 白屏**（2026-09-10 实测，**已由上游修复**）：用户 `web` profile 里的 `@kenz1117/dsh-ui-usage-billing@1.1.12`（12:03 装/更新）客户端 bundle `require("@deepseek-ai/dsh-client-runtime/client")`，这个 specifier 既不在平台 seed 表、也不是已注册的包 factory → 客户端 boot 直接 `Failed to load plugins`，**所有插件的入口（包括本插件）都不出现**。12:40:56 该包更新到 **1.2.0** 后不再引用它，真机复核用户 profile 已恢复正常。教训：① 客户端侧一个坏 external 能拖垮整页，排查时先看页面顶上那行红字；② 验证本插件时别把这种环境故障当成插件问题，必要时用 §8 的干净 profile 配方。
15. **验证客户端半边要一个新进程 + 干净 profile**：`dsh --profile web --port 0` 起第二个实例即可（会和用户的 3080 共用 `~/.dsh`，但 `--patch` 能把 `settings-file` 指到 scratch 文件，不碰真设置）；如果用户的 profile 里有坏插件，改用 §8 的三行配方建一个只装 `dsh-base` + `dsh-web-app` + 本插件的 `webverify`。

---

## 7. 下一步（按优先级）

1. **U2 真实子代理**：跑一次 `subagent` 调用，确认子会话的 `request/header` 未被改写；再开 `applyToSubagents: true` 对比。
2. **U3 非 DeepSeek provider**：接一个声明 3 档或 5 档的 provider，验证钳制。
3. **发布**：`pnpm publish`（`prepublishOnly` 会构建）；发布后把 README 的安装命令改成包名优先。
4. **U6 卸载安全**：现在卸载后选着 Auto 的会话会报错。可选方案：给 profile 加一条 `cordis.patch.yml` 兜底行（把 `auto` 映射到 provider 默认），或做一个"插件缺失时自动降级"的 companion。
5. 可选：给 GUI 加“本轮档位”只读显示（命名空间已注册、设置页已在，所以这只需再加一个展示型 slot）
6. 可选：设置页里支持编辑 `levels`/`rules`（结构化表单，成本明显高于当前字段）

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

# 验证客户端半边（设置页）：干净 profile 三行配方（用户 profile 有坏插件时用）
#   1) 建 C:\Users\Cooper\.dsh\profiles\webverify\package.json，dsh.profile.bundles = [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-auto-thinking-effort]
#   2) dsh plugin --profile webverify add C:\CodeRepository\dsh-auto-thinking-effort
#   3) dsh --profile webverify --patch .verify/hot.yml --port 0 --no-open
#   → 打开日志里的 URL，设置里就应出现「自动思考强度」；验证完删掉该 profile 目录即可

# 只看判定不改请求：加 --patch 覆盖 dryRun: true（模板见 .verify/）
```

---

## 9. 交接清单

- [x] 代码 + 单测（116 个）+ CI workflow
- [x] Auto 档位注入（D10）与「手动优先」（D11）与全局默认守卫（D12）
- [x] 边界策略对齐 oh-my-pi（D13 下限 / D14 上限 / D15 pin 只在正文 / D16 钳制方向）
- [x] **可选模型分类后端**（D17，v0.6.0 起为默认；D20）：`classifier: heuristic|model`，真机 A/B 验证
- [x] 真机挂载与请求头证据（含对照组）
- [x] **GUI 真机验证**：Auto 出现并可选中、每轮自动、手动不被覆盖、默认不被污染
- [x] v0.3 / v0.4 真机证据（下限 / pin 越天花板 / 天花板挡高分 / 模型分类 A/B / 分类失败回落）
- [x] 装进用户的 `web` profile（bundle 已追加；重启后生效）
- [x] **浏览器半边 + 设置里独立一页（D19/D20）**：真机验证「导航出现 / 表单渲染 / 下拉 / 保存写入 / host 采纳 / 重置」（用户重启 `dsh web` 后即可看到；注意 §6 陷阱 14 的环境故障）
- [x] 设计决策与证据位置（`docs/design.md` D1–D20）
- [x] **settings 命名空间 + 热重配（D18）**：真机验证用户层生效与同一进程内热重配；用户 `web` profile 与 `~/.dsh/settings.yaml` 已接好
- [x] 中英 README，含「真机验证 / 仅单测 / 未验证」三张表 + oh-my-pi 对比表
- [ ] 真实子代理跳过验证（U2）
- [ ] 发布到 npm
