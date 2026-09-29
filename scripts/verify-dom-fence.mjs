/**
 * Runnable regression check for the DOM render channel's fence
 * identification — the channel that has to work on hosts with no fence
 * registry extension point.
 *
 * Run with `pnpm verify:fence` (tsx). It needs neither a DSH source checkout
 * nor a running harness: jsdom + react come from this package's own
 * node_modules, and the host's ui-primitives package is stubbed because the
 * channel only imports three components from it that this check never renders.
 *
 * What it pins down (each case is a real regression risk):
 *  1. label path  — the stock banner whose label is literally `dsh-ui`.
 *  2. props path  — DSH 0.2.0's toolbar banner replaces an unknown language
 *     hint with a generic label, so the fence is identified through the
 *     surface's original `lang` prop instead.
 *  3. anti-hijack — a readable non-fence language is never taken over.
 *  4. content path — when the banner masks the label AND no props are readable
 *     (future React build), a body that parses as a GenUI spec still renders.
 *  5. anti-hijack for the content path — an unparsable body stays a code block.
 * @module scripts/verify-dom-fence
 */
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/* Registered before the channel import so it lands AFTER tsx's own loader in
 * the hook chain (tsx otherwise resolves the real package and dies on its CSS
 * module imports). */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        url: 'data:text/javascript,'
          + 'const Null=()=>null;'
          + 'export const CodeBlock=Null,DiffBlock=Null,JsonTree=Null;'
          + 'export default {};',
        shortCircuit: true,
      }
    }
    if (specifier.endsWith('.css')) {
      return { url: 'data:text/javascript,export default {}', shortCircuit: true }
    }
    return next(specifier, context)
  },
})

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const g = globalThis
g.window = dom.window
g.document = dom.window.document
g.MutationObserver = dom.window.MutationObserver
g.Node = dom.window.Node
g.Element = dom.window.Element
g.HTMLElement = dom.window.HTMLElement
g.getComputedStyle = dom.window.getComputedStyle
g.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0)
g.cancelAnimationFrame = (id) => clearTimeout(id)
try {
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
} catch {
  /* Node keeps its own navigator; nothing here reads it. */
}

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { installDomFenceRenderer } = await import(pathToFileURL(resolve(root, 'src/client/dom-fence.tsx')).href)

const SPEC = '{"title":"t","items":[{"type":"text","size":"body","content":"VERIFY-OK"}]}'
const NOT_A_SPEC = 'def parse(node):\n    return node.children  # not a GenUI spec'

/** The host code surface: banner (optionally a toolbar one) + `<pre>` body.
 * `lang` is the REAL prop name the host component carries (the channel reads
 * it off the fiber), deliberately separate from `shownLabel`: a toolbar banner
 * can thus be rendered with a masked label and either a readable or an absent
 * `lang` prop. */
function StockBlock({ lang, shownLabel, body }) {
  return React.createElement('div', { className: 'md-code-block' },
    React.createElement('div', { className: 'banner', 'data-code-block-banner': 'true' },
      React.createElement('div', { className: 'heading' },
        React.createElement('span', { className: 'language' }, shownLabel)),
      React.createElement('div', { className: 'actions' },
        React.createElement('button', { type: 'button' }, 'Copy'))),
    React.createElement('div', { className: 'content', 'data-code-block-content': 'true' },
      React.createElement('pre', { className: 'plain' },
        React.createElement('code', null, body))))
}

/** Renders one host block, runs the channel over it, returns what happened. */
async function probe(props) {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root_ = createRoot(host)
  root_.render(React.createElement(StockBlock, props))
  await new Promise((r) => setTimeout(r, 60))

  const block = host.querySelector('.md-code-block')
  const dispose = installDomFenceRenderer({}, () => {})
  await new Promise((r) => setTimeout(r, 150))

  const takenOver = block.hasAttribute('data-genui-rendered')
  const rendered = block.nextElementSibling ? block.nextElementSibling.textContent ?? '' : ''
  dispose()
  root_.unmount()
  host.remove()
  return { takenOver, rendered }
}

const cases = [
  {
    name: '传统横幅 + 标签就是 dsh-ui（标签路径）',
    props: { lang: 'dsh-ui', shownLabel: 'dsh-ui', body: SPEC },
    expect: true,
  },
  {
    name: '0.2.0 工具栏横幅 + props 可读（props 路径）',
    props: { lang: 'dsh-ui', shownLabel: '代码', body: SPEC },
    expect: true,
  },
  {
    name: '工具栏横幅 + 可读的非围栏语言（防误伤）',
    props: { lang: 'json', shownLabel: 'JSON', body: SPEC },
    expect: false,
  },
  {
    name: '工具栏横幅 + props 不可读、正文是合法 spec（正文兜底）',
    props: { lang: undefined, shownLabel: '代码', body: SPEC },
    expect: true,
  },
  {
    name: '工具栏横幅 + props 不可读、正文不是 spec（防误伤）',
    props: { lang: undefined, shownLabel: '代码', body: NOT_A_SPEC },
    expect: false,
  },
]

let failed = 0
for (const c of cases) {
  const { takenOver, rendered } = await probe(c.props)
  const ok = takenOver === c.expect
  if (!ok) failed += 1
  const detail = c.expect ? `渲染内容含 VERIFY-OK=${rendered.includes('VERIFY-OK')}` : '保持为代码块'
  console.log(`${ok ? '✅' : '❌'} ${c.name} — 接管=${takenOver}（期望 ${c.expect}）；${detail}`)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
