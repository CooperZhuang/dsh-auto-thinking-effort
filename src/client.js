/**
 * Browser half of dsh-auto-thinking-effort: the settings card that edits this
 * plugin's settings namespace inside 设置 → 插件 → 插件配置.
 *
 * Why this file is hand-written in the client module system's own format rather
 * than built from TypeScript like every other source file here: a browser half
 * must arrive as a *client bundle* — a classic script that registers one lazy
 * CJS factory through `window.__ModuleLoader__.load` — and the preset that
 * produces that shape (`packages/client/tsdown.client.ts`) lives in the DSH
 * monorepo and is not a published package, so a plugin outside that repository
 * has to author the shape itself. Writing it directly means there is no bundler
 * step to drift, no externals to declare (React and the slot service are seeded
 * by the shell), and the whole browser half stays one reviewable file.
 *
 * Protocol (see `@deepseek-ai/dsh-client-modules`): the factory is registered,
 * not executed; the shell materializes it on first import, hands it a `require`
 * answered by the platform module table, and treats the returned exports as the
 * client plugin. The `id` must equal this package's name — it is the graph row
 * the shell executes.
 *
 * Everything the card does rides two public seams and nothing else:
 *
 * - `ctx.slots` contributes into `settings.plugin.item` under this plugin's
 *   settings namespace. That is the whole contract: the tab pairs served
 *   namespaces with cards registered under the same key without knowing what
 *   the namespace means.
 * - `ctx.settingsScope` binds the namespace, so reads come from the shared
 *   document mirror and every write is revision-fenced against concurrent
 *   writers. Save is one atomic mutation; a field left empty clears that field,
 *   which is how a value re-inherits the composition row.
 */
;(function register() {
  const NAMESPACE = 'auto-thinking-effort'
  const PACKAGE = 'dsh-auto-thinking-effort'
  /** Level ids used when the configured ladder is empty (= the shipped ladder). */
  const SHIPPED_LEVELS = ['minimal', 'low', 'high', 'max']

  /** The card's fields, in reading order: what toggles, then what tunes. */
  const FIELDS = [
    {
      key: 'enabled',
      kind: 'toggle',
      label: '总开关 enabled',
      hint: '关掉后不再注入 Auto 档位、不再分类；兜底改写仍会注册，防止已存的 Auto 漏给 provider。',
    },
    {
      key: 'classifier',
      kind: 'select',
      options: ['heuristic', 'model'],
      labels: { heuristic: 'heuristic（纯正则，零调用）', model: 'model（一次小模型调用）' },
      label: '分类后端 classifier',
      hint: 'model 后端超时或失败时一律回落到启发式判定，不会让这一轮失败。',
    },
    {
      key: 'classifierModel',
      kind: 'text',
      label: '分类模型 classifierModel',
      hint: 'provider/model；留空 = 用该会话自己的路线。指一个小而快的模型。',
    },
    {
      key: 'autoFloorLevel',
      kind: 'level',
      label: '下限 autoFloorLevel',
      hint: 'minimal = 不设下限（可以到 off）；改成 low 就永远不关思考。',
    },
    {
      key: 'autoCeilingLevel',
      kind: 'level',
      label: '上限 autoCeilingLevel',
      hint: '分数算出来的档位不超过它；只有显式 pin（深入思考 / ultrathink）能到最高档。',
    },
    {
      key: 'maxChars',
      kind: 'number',
      label: 'maxChars',
      hint: '每轮最多看多少字符（超长保留头 60% + 尾 40%）；必须 ≥ 32。',
    },
    {
      key: 'classifierTimeoutMs',
      kind: 'number',
      label: 'classifierTimeoutMs',
      hint: '单次模型分类的硬超时（毫秒）；必须 ≥ 250。',
    },
    {
      key: 'classifierMaxTokens',
      kind: 'number',
      label: 'classifierMaxTokens',
      hint: '模型分类的输出上限（它只回一个档位词）。',
    },
    {
      key: 'autoWhenUnset',
      kind: 'toggle',
      label: 'autoWhenUnset',
      hint: '请求上没有显式档位时是否也算自动。',
    },
    {
      key: 'applyToSubagents',
      kind: 'toggle',
      label: 'applyToSubagents',
      hint: '是否也管子代理会话（子代理的路线和档位通常由调用方决定）。',
    },
    {
      key: 'inheritOnContinuation',
      kind: 'toggle',
      label: 'inheritOnContinuation',
      hint: '裸接续（"继续"、"ok"）是否继承上一轮的档位。',
    },
    {
      key: 'dryRun',
      kind: 'toggle',
      label: 'dryRun',
      hint: '只判定并打日志，不改写请求。第一次观察真实判断时很有用。',
    },
    {
      key: 'logDecisions',
      kind: 'toggle',
      label: 'logDecisions',
      hint: '每轮打一行 info：档位、分数、理由。',
    },
  ]

  /** Inline styles: the card lives outside every stylesheet, so it carries its own. */
  const styles = {
    card: {
      border: '0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28))',
      borderRadius: '12px',
      marginBottom: '8px',
      overflow: 'hidden',
    },
    header: {
      alignItems: 'center',
      background: 'none',
      border: 'none',
      color: 'inherit',
      cursor: 'pointer',
      display: 'flex',
      font: 'inherit',
      gap: '12px',
      justifyContent: 'space-between',
      padding: '12px 16px',
      textAlign: 'left',
      width: '100%',
    },
    title: { fontSize: '13px', fontWeight: 500, lineHeight: 1.5 },
    description: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', fontSize: '12px', lineHeight: 1.5 },
    body: { borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28))', padding: '4px 16px 12px' },
    field: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0' },
    fieldHead: { alignItems: 'center', display: 'flex', gap: '8px' },
    label: { flex: 1, fontSize: '13px', fontWeight: 500, lineHeight: 1.5 },
    badge: {
      background: 'var(--dsw-alias-bg-module-platform, rgba(128, 128, 128, 0.14))',
      borderRadius: '999px',
      color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
      fontSize: '11px',
      lineHeight: '17px',
      padding: '1px 8px',
      whiteSpace: 'nowrap',
    },
    reset: {
      background: 'none',
      border: 'none',
      color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: 1.5,
      padding: 0,
    },
    control: {
      background: 'var(--dsw-alias-bg-layer-3, transparent)',
      border: '0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.36))',
      borderRadius: '8px',
      color: 'inherit',
      font: 'inherit',
      fontSize: '13px',
      height: '34px',
      lineHeight: 1.5,
      padding: '0 12px',
      width: '100%',
    },
    hint: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', fontSize: '12px', lineHeight: 1.5, margin: 0 },
    error: { color: 'var(--dsw-alias-label-error, #d4380d)', fontSize: '12px', lineHeight: 1.5, margin: 0 },
    footer: {
      alignItems: 'center',
      borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28))',
      display: 'flex',
      gap: '8px',
      justifyContent: 'flex-end',
      paddingTop: '12px',
    },
    primary: {
      background: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      border: 'none',
      borderRadius: '8px',
      color: '#fff',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: '13px',
      height: '30px',
      padding: '0 14px',
    },
    secondary: {
      background: 'none',
      border: '0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.36))',
      borderRadius: '8px',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: '13px',
      height: '30px',
      padding: '0 14px',
    },
    note: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', fontSize: '12px', lineHeight: 1.5, margin: '4px 0 0' },
  }

  /**
   * The level ids a bound select may offer, low to high.
   * @param value - the resolved configuration, when one stands.
   * @returns the configured ladder, or the shipped one while it is empty.
   */
  function levelIds(value) {
    const levels = value === undefined || value === null ? undefined : value.levels
    if (!Array.isArray(levels) || levels.length === 0) return SHIPPED_LEVELS
    return levels.map((level) => String(level.id))
  }

  /**
   * Render one field's text for the control from the resolved value.
   * @param field - the field spec.
   * @param value - the resolved field value.
   * @returns the text a control shows for it.
   */
  function text(value) {
    if (value === undefined || value === null) return ''
    return String(value)
  }

  /**
   * Turn one staged draft into the JSON value a write carries.
   * @param field - the field spec.
   * @param draft - the staged text.
   * @returns the value to write, or `undefined` when the draft is unusable.
   */
  function coerce(field, draft) {
    if (field.kind === 'toggle') return draft === 'true'
    if (field.kind === 'number') {
      const parsed = Number(draft)
      return Number.isFinite(parsed) && draft.trim() !== '' ? parsed : undefined
    }
    return draft
  }

  /**
   * Whether a staged draft is something this card refuses to send.
   * @param field - the field spec.
   * @param draft - the staged text.
   * @returns whether the draft is invalid (save is blocked, never silently dropped).
   */
  function invalid(field, draft) {
    if (draft === '') return false
    const value = coerce(field, draft)
    if (value === undefined) return true
    if (field.kind === 'number' && field.key === 'maxChars' && value < 32) return true
    if (field.kind === 'number' && field.key === 'classifierTimeoutMs' && value < 250) return true
    if (field.kind === 'number' && field.key === 'classifierMaxTokens' && value < 1) return true
    return false
  }

  /**
   * Build the card component bound to one namespace scope.
   * @param React - the platform React instance.
   * @param scope - the client settings scope for this namespace.
   * @returns the component registered into `settings.plugin.item`.
   */
  function createCard(React, scope) {
    const h = React.createElement

    /**
     * One field row: label, control, override badge, reset, hint, error.
     * @param source - the field spec.
     * @param value - the current resolved value of the field.
     * @param draft - the staged text, when one stands.
     * @param overridden - whether the field is present in the raw user layer.
     * @param disabled - whether the Host document refuses writes.
     * @param levels - the level ids a level select may offer.
     * @param onStage - stage one draft for this field.
     * @param onReset - stage clearing this field.
     * @returns the row.
     */
    function row(source, value, draft, overridden, disabled, levels, onStage, onReset) {
      const shown = draft !== undefined ? draft : text(value)
      const bad = draft !== undefined && invalid(source, shown)
      const options = source.kind === 'level'
        ? levels.concat(['$weakest', '$strongest'])
        : source.kind === 'select' ? source.options : source.kind === 'toggle' ? ['true', 'false'] : undefined

      const control = options === undefined
        ? h('input', {
            disabled,
            onChange: (event) => { onStage(event.target.value) },
            style: styles.control,
            type: source.kind === 'number' ? 'number' : 'text',
            value: shown,
          })
        : h('select', {
            disabled,
            onChange: (event) => { onStage(event.target.value) },
            style: styles.control,
            value: shown,
          }, options.map((option) => h('option', { key: option, value: option },
            (source.labels !== undefined && source.labels[option] !== undefined
              ? source.labels[option]
              : source.kind === 'toggle' ? (option === 'true' ? '开启' : '关闭') : option))))

      return h('div', { key: source.key, style: styles.field },
        h('div', { style: styles.fieldHead },
          h('div', { style: styles.label }, source.label),
          overridden ? h('span', { style: styles.badge }, '已覆盖') : null,
          overridden && !disabled
            ? h('button', { onClick: onReset, style: styles.reset, type: 'button' }, '重置')
            : null),
        control,
        bad
          ? h('p', { style: styles.error }, '这个值 Host 不会接受。')
          : h('p', { style: styles.hint }, source.hint))
    }

    return function AutoThinkingEffortCard() {
      const snapshot = React.useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot(),
      )
      const [open, setOpen] = React.useState(false)
      const [drafts, setDrafts] = React.useState({})
      const [fence, setFence] = React.useState(undefined)
      const [saving, setSaving] = React.useState(false)
      const [failure, setFailure] = React.useState(undefined)

      const user = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : {}
      const levels = levelIds(snapshot.value)
      const staged = Object.keys(drafts)

      if (snapshot.status !== 'ready') return null

      /**
       * Stage one field's draft, fencing the write at the revision the draft
       * started from so a concurrent editor refuses this save instead of
       * silently overwriting.
       * @param key - the field.
       * @param text - the draft.
       */
      function stage(key, text) {
        if (fence === undefined) setFence(snapshot.revision)
        setDrafts((current) => {
          const next = { ...current }
          next[key] = text
          return next
        })
      }

      /**
       * Stage a clear for one field, so it re-inherits the composition row.
       * @param key - the field.
       */
      function reset(key) {
        if (fence === undefined) setFence(snapshot.revision)
        setDrafts((current) => {
          const next = { ...current }
          next[key] = ''
          return next
        })
      }

      /** Write every staged edit as one atomic mutation. */
      async function save() {
        const ops = []
        for (const key of Object.keys(drafts)) {
          const source = FIELDS.find((field) => field.key === key)
          if (source === undefined) continue
          const draft = drafts[key]
          if (draft === '') {
            ops.push({ op: 'unset', path: [key] })
            continue
          }
          ops.push({ op: 'set', path: [key], value: coerce(source, draft) })
        }
        if (ops.length === 0) {
          setDrafts({})
          setFence(undefined)
          return
        }
        setSaving(true)
        setFailure(undefined)
        try {
          await scope.mutate(ops, fence)
          setDrafts({})
          setFence(undefined)
          setOpen(false)
        } catch (error) {
          setFailure(error !== null && typeof error === 'object' && typeof error.message === 'string'
            ? error.message
            : String(error))
        } finally {
          setSaving(false)
        }
      }

      const blocked = !snapshot.writable || saving
        || staged.some((key) => {
          const source = FIELDS.find((field) => field.key === key)
          return source === undefined || invalid(source, drafts[key])
        })

      const disabled = !snapshot.writable || saving

      return h('div', { style: styles.card },
        h('button', {
          'aria-expanded': open,
          onClick: () => { setOpen(!open) },
          style: styles.header,
          type: 'button',
        },
          h('div', null,
            h('div', { style: styles.title }, '自动档位 Auto（每轮按提问选择推理 effort）'),
            h('div', { style: styles.description },
              '在选择器里加一个 Auto 档位；选中后每轮按你的提问决定 effort，手动档位（off/low/high/max）不受影响。')),
          h('div', { style: styles.description }, staged.length > 0 ? `未保存 ${staged.length}` : (open ? '▾' : '▸'))),
        open
          ? h('div', { style: styles.body },
              snapshot.writable
                ? null
                : h('p', { style: styles.error }, '这个连接把偏好设置留在本地进程内，不能写回 Host 文档。'),
              h('p', { style: styles.note }, '留空并保存 = 清除这一项的覆盖，重新继承 profile 里的组装值。'),
              FIELDS.map((source) => row(
                source,
                snapshot.value === undefined ? undefined : snapshot.value[source.key],
                drafts[source.key],
                Object.prototype.hasOwnProperty.call(user, source.key),
                disabled,
                levels,
                (next) => { stage(source.key, next) },
                () => { reset(source.key) },
              )),
              failure === undefined ? null : h('p', { style: styles.error }, `保存失败：${failure}`),
              h('p', { style: styles.note },
                '档位阶梯 levels 与自定义规则 rules 是结构化配置，请直接编辑 ~/.dsh/settings.yaml 的 auto-thinking-effort 段（改完立即生效，不用重启）。'),
              h('div', { style: styles.footer },
                h('button', {
                  disabled: staged.length === 0 || saving,
                  onClick: () => { setDrafts({}); setFence(undefined); setFailure(undefined) },
                  style: styles.secondary,
                  type: 'button',
                }, '放弃修改'),
                h('button', {
                  disabled: blocked || staged.length === 0,
                  onClick: () => { void save() },
                  style: styles.primary,
                  type: 'button',
                }, saving ? '保存中…' : '保存')))
          : null)
    }
  }

  const target = globalThis.window === undefined ? undefined : globalThis.window.__ModuleLoader__
  if (target === undefined) {
    throw new Error(`${PACKAGE}: window.__ModuleLoader__ is missing — this bundle is served by the DSH web shell and cannot be loaded directly`)
  }

  target.load({
    id: PACKAGE,
    factory: (require) => {
      const React = require('react')

      /**
       * Mount the card on the calling plugin's lifecycle.
       * @param ctx - the browser plugin context.
       */
      function apply(ctx) {
        const scope = ctx.settingsScope.bind({ namespace: NAMESPACE })
        ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
          { name: 'settings.plugin.item', key: NAMESPACE },
          createCard(React, scope),
        ))
      }

      return { inject: ['slots', 'settingsScope'], apply }
    },
  })
})()
