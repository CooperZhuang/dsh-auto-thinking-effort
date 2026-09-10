/**
 * Wiring tests for the browser half (`src/client.js`).
 *
 * The browser half is a classic script in the client module system's format, so
 * there is no module to import: the bundle is executed with a stub
 * `window.__ModuleLoader__`, and the factory it registers is handed a fake React
 * and a fake plugin context. What this covers is the form's *logic* — staging,
 * the write it composes, and how it reports success and failure — not layout.
 *
 * The first case is a regression guard: `save()` used to take an `onSaved`
 * callback that its only caller never passed, so a successful write was
 * immediately followed by a `TypeError` that the catch block reported as
 * "保存失败: onSaved is not a function" — the settings document had already been
 * written. Anything that runs after the write settles must stay inside the try
 * only if a throw there could not be confused with a rejected write.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

/** One element as the fake React builds it. */
interface Element {
  type: unknown
  props: Record<string, unknown>
}

/** The fake React and the hooks runtime behind it. */
interface FakeReact {
  React: {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => Element
    useState: (initial: unknown) => [unknown, (next: unknown) => void]
    useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) => unknown
  }
  /** Point the runtime at a component and render it. */
  render: (component: () => unknown) => unknown
}

/**
 * Build a fake React with just enough hooks for the settings form.
 *
 * One component renders the whole form (`form` and its rows are plain
 * functions, not components), so a single hooks array and a single cursor are
 * faithful here.
 * @returns the React surface and the render entry point.
 */
function fakeReact(): FakeReact {
  const hooks: unknown[] = []
  let cursor = 0
  let component: (() => unknown) | undefined

  const render = (): unknown => {
    cursor = 0
    return component === undefined ? undefined : component()
  }
  const update = (): void => { render() }

  return {
    React: {
      createElement: (type, props, ...children) => ({
        type,
        props: {
          ...(props ?? {}),
          ...children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children },
        },
      }),
      useState: (initial) => {
        const index = cursor++
        if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
        const set = (next: unknown): void => {
          hooks[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(hooks[index]) : next
          update()
        }
        return [hooks[index], set]
      },
      useSyncExternalStore: (subscribe, getSnapshot) => {
        const index = cursor++
        if (!(index in hooks)) {
          hooks[index] = true
          subscribe(update)
        }
        return getSnapshot()
      },
    },
    render: (next) => {
      component = next
      return render()
    },
  }
}

/** Every element in a rendered tree, parents first. */
function elements(node: unknown): Element[] {
  if (node === null || typeof node !== 'object') return []
  const element = node as Element
  const children = element.props.children
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children]
  return [element, ...list.flatMap((child) => elements(child))]
}

/** The text of a rendered subtree, joined. */
function text(node: unknown): string {
  if (typeof node === 'string') return node
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map((child) => text(child)).join('')
  const children = (node as Element).props?.children
  return text(children)
}

/**
 * The innermost element that holds one field: its label, its control, its hint.
 * @param tree - a rendered tree.
 * @param label - the field's label text.
 * @returns the field container, or `undefined` when it is not rendered.
 */
function fieldFor(tree: unknown, label: string): Element | undefined {
  // Parents come first, so the last match is the tightest one: the field itself
  // rather than some ancestor that also happens to contain the label.
  return elements(tree)
    .filter((element) => text(element).includes(label)
      && elements(element).some((child) => typeof child.props.onChange === 'function'))
    .at(-1)
}

/**
 * The control inside one field.
 * @param field - the field container.
 * @returns the element carrying `onChange`.
 */
function controlIn(field: Element): Element | undefined {
  return elements(field).find((element) => typeof element.props.onChange === 'function')
}

/**
 * One button inside a subtree.
 * @param node - a rendered subtree.
 * @param label - the button's text.
 * @returns the button element, or `undefined`.
 */
function buttonIn(node: Element, label: string): Element | undefined {
  return elements(node).find((element) => element.type === 'button' && text(element) === label)
}

/** A snapshot the bound scope answers with. */
function snapshot(revision: number, value: Record<string, unknown>, user: Record<string, unknown> = {}) {
  return {
    status: 'ready' as const,
    value,
    base: undefined,
    user,
    revision,
    writable: true,
    mode: 'host' as const,
  }
}

/**
 * Load the bundle and mount it against a fake context.
 * @param scope - the settings scope the page should bind.
 * @returns the registered component and the recordings of its writes.
 */
function mount(scope: { getSnapshot: () => unknown; subscribe: () => () => void; mutate: (ops: unknown[], fence: unknown) => Promise<void> }) {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  let registration: { factory: (require: (spec: string) => unknown) => { apply: (ctx: unknown) => void } } | undefined
  const globals = globalThis as { window?: unknown }
  const previous = globals.window
  globals.window = { __ModuleLoader__: { load: (next: unknown) => { registration = next as typeof registration } } }
  try {
    // The bundle is a classic script, not a module: run it for its registration.
    new Function(source)()
  } finally {
    globals.window = previous
  }
  if (registration === undefined) throw new Error('src/client.js registered no bundle')

  const fake = fakeReact()
  let component: (() => unknown) | undefined
  const plugin = registration.factory((spec) => {
    if (spec === 'react') return fake.React
    throw new Error(`unexpected module request: ${spec}`)
  })
  plugin.apply({
    settingsScope: { bind: () => scope },
    slots: {
      inject: (_name: string, callback: () => void) => { callback() },
      register: (_options: unknown, registered: () => unknown) => { component = registered as () => unknown },
    },
    // No remote: the model field degrades to free text, which this test ignores.
    inject: () => {},
  })
  if (component === undefined) throw new Error('the plugin registered no section')
  return { render: () => fake.render(component as () => unknown) }
}

/** Let a settled promise chain run. */
const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

describe('settings page', () => {
  it('saves a staged field without reporting a failure it invented', async () => {
    const mutate = vi.fn(async () => {})
    const scope = {
      getSnapshot: () => snapshot(7, { enabled: true, autoFloorLevel: 'minimal', classifier: 'model' }),
      subscribe: () => () => {},
      mutate,
    }
    const { render } = mount(scope)
    const field = fieldFor(render(), '下限 autoFloorLevel')
    expect(field).toBeDefined()
    const control = field === undefined ? undefined : controlIn(field)
    expect(control).toBeDefined()
    ;(control?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'low' } })

    const save = buttonIn(render() as Element, '保存')
    expect(save).toBeDefined()
    ;(save?.props.onClick as () => void)()
    await flush()

    // One atomic mutation, fenced at the revision the draft started from.
    expect(mutate).toHaveBeenCalledTimes(1)
    const [ops, fence] = mutate.mock.calls[0] as unknown as [unknown[], unknown]
    expect(ops).toEqual([{ op: 'set', path: ['autoFloorLevel'], value: 'low' }])
    expect(fence).toBe(7)

    // The write succeeded, so the page must say nothing about a failure, and
    // the draft is gone: saving again is a no-op.
    const after = render()
    expect(text(after)).not.toContain('保存失败')
    expect(buttonIn(after as Element, '保存')?.props.disabled).toBe(true)
  })

  it('reports a rejected write instead of swallowing it', async () => {
    const mutate = vi.fn(async () => { throw new Error('settings: revision is stale') })
    const scope = {
      getSnapshot: () => snapshot(7, { enabled: true, autoFloorLevel: 'minimal', classifier: 'model' }),
      subscribe: () => () => {},
      mutate,
    }
    const { render } = mount(scope)
    const field = fieldFor(render(), '下限 autoFloorLevel') as Element
    const control = controlIn(field)
    ;(control?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'low' } })

    const save = buttonIn(render() as Element, '保存')
    ;(save?.props.onClick as () => void)()
    await flush()

    const after = render()
    expect(text(after)).toContain('保存失败：settings: revision is stale')
    // The draft survives, so the user can retry once the conflict is gone.
    expect(buttonIn(after as Element, '保存')?.props.disabled).toBe(false)
  })

  it('clears an overridden field by staging an unset', async () => {
    const mutate = vi.fn(async () => {})
    const scope = {
      getSnapshot: () => snapshot(3, { enabled: true, autoFloorLevel: 'minimal', classifier: 'model' }, { autoFloorLevel: 'minimal' }),
      subscribe: () => () => {},
      mutate,
    }
    const { render } = mount(scope)
    const field = fieldFor(render(), '下限 autoFloorLevel') as Element
    expect(text(field)).toContain('已覆盖')

    const reset = buttonIn(field, '重置')
    expect(reset).toBeDefined()
    ;(reset?.props.onClick as () => void)()

    const save = buttonIn(render() as Element, '保存')
    ;(save?.props.onClick as () => void)()
    await flush()

    expect(mutate).toHaveBeenCalledTimes(1)
    const [ops] = mutate.mock.calls[0] as unknown as [unknown[]]
    expect(ops).toEqual([{ op: 'unset', path: ['autoFloorLevel'] }])
  })
})
