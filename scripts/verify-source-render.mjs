/**
 * Runnable integration check for the workspace data binding (`pnpm
 * verify:source-render`): renders REAL GenuiBlocks through the same React
 * pipeline the conversation uses (provider → block → dispatcher → table /
 * chart body) against a fake reader, so the hook, the session context, the
 * node dispatch and the cache are exercised together — the pure parsers are
 * covered separately by verify-source.mjs.
 *
 * Run with tsx; jsdom + react come from this package's own node_modules. The
 * host's ui-primitives package is stubbed (nothing here renders it) and CSS
 * imports resolve to an empty object (class names are not under test).
 * @module scripts/verify-source-render
 */
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

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
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
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

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { GenuiBlock } = await import(pathToFileURL(resolve(root, 'src/client/GenuiBlock.tsx')).href)
const { GenuiSessionProvider, setGenuiSourceReader, clearSourceCache } = await import(
  pathToFileURL(resolve(root, 'src/client/data-source.tsx')).href
)
const { repairGenuiSpec } = await import(pathToFileURL(resolve(root, 'src/client/guard.ts')).href)

const CSV = 'day,ms\n周一,12\n周二,15\n'

/** Install a reader over authored text and count its calls. */
function useReader(read) {
  const reader = (...args) => { reader.calls.push(args[1]); return read(...args) }
  reader.calls = []
  setGenuiSourceReader(reader)
  return reader
}

/** Render a block (optionally without a session) and return the mounted host.
 * `sessionId: null` means "no provider at all" (outside a session). */
async function mount(spec, { sessionId = 'S1', settle = 80 } = {}) {
  const raw = repairGenuiSpec(spec)
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const reactRoot = createRoot(host)
  const block = React.createElement(GenuiBlock, { spec: raw })
  reactRoot.render(sessionId === null
    ? block
    : React.createElement(GenuiSessionProvider, { sessionId }, block))
  await new Promise((r) => setTimeout(r, settle))
  return { host, text: () => host.textContent ?? '', done: () => { reactRoot.unmount(); host.remove() } }
}

const cases = []
const check = (name, ok) => cases.push([name, ok === true])

/* 1. table from CSV ------------------------------------------------------- */

clearSourceCache()
useReader(() => Promise.resolve({ ok: true, read: { text: CSV, complete: true } }))
{
  const view = await mount({ title: 't', items: [{ type: 'table', source: { path: 'data/a.csv' } }] })
  const text = view.text()
  const cells = [...view.host.querySelectorAll('td')].map((td) => td.textContent)
  check('源表渲染出表头与数据行', text.includes('day') && text.includes('ms') && cells.join('|') === '周一|12|周二|15')
  check('源表不出现在错误/提示态', view.host.querySelector('[role="alert"]') === null)
  view.done()
}

/* 2. reader failure degrades to one note --------------------------------- */

clearSourceCache()
useReader(() => Promise.resolve({ ok: false, message: 'ENOENT: no such file' }))
{
  const view = await mount({ items: [{ type: 'table', source: { path: 'missing.csv' } }] })
  const alert = view.host.querySelector('[role="alert"]')
  check('读取失败显示一行提示且不抛错', alert !== null && (alert.textContent ?? '').includes('ENOENT'))
  check('失败时表格不再渲染', view.host.querySelector('table') === null)
  view.done()
}

/* 3. chart from CSV ------------------------------------------------------- */

clearSourceCache()
useReader(() => Promise.resolve({ ok: true, read: { text: CSV, complete: true } }))
{
  const view = await mount({ items: [{ type: 'chart', kind: 'bars', source: { path: 'data/a.csv' } }] })
  const text = view.text()
  // Class names are stubbed away here, so the assertion reads the bar titles
  // (label: value), which only exist once a bar actually rendered.
  const bars = [...view.host.querySelectorAll('[title]')].map((n) => n.getAttribute('title'))
  check('源图渲染出柱条与标签', bars.includes('周一: 12') && bars.includes('周二: 15'))
  view.done()
}

/* 4. truncation note ------------------------------------------------------ */

clearSourceCache()
useReader(() => Promise.resolve({ ok: true, read: { text: CSV, complete: false } }))
{
  const view = await mount({ items: [{ type: 'table', source: { path: 'big.csv' } }] })
  check('文件未读完时表格下带截断说明', view.text().includes('仅显示前'))
  view.done()
}

/* 5. no host service / no session ---------------------------------------- */

clearSourceCache()
setGenuiSourceReader(undefined)
{
  const view = await mount({ items: [{ type: 'table', source: { path: 'a.csv' } }] })
  check('宿主没有工作区服务时给出提示', view.text().includes('工作区文件服务'))
  view.done()
}
clearSourceCache()
useReader(() => Promise.resolve({ ok: true, read: { text: CSV, complete: true } }))
{
  const view = await mount({ items: [{ type: 'table', source: { path: 'a.csv' } }] }, { sessionId: null })
  check('没有会话上下文时给出提示', view.text().includes('不在会话里'))
  view.done()
}

/* 6. the same source is read once, even from two surfaces ---------------- */

clearSourceCache()
const shared = useReader(() => Promise.resolve({ ok: true, read: { text: CSV, complete: true } }))
{
  const spec = { items: [{ type: 'table', source: { path: 'data/shared.csv' } }] }
  const first = await mount(spec)
  const second = await mount(spec)
  check('同一来源的多处渲染只读一次文件', shared.calls.length === 1 && shared.calls[0] === 'data/shared.csv')
  check('缓存命中后第二处也渲染出数据', second.text().includes('周一'))
  first.done()
  second.done()
}

/* 7. nested inside other components -------------------------------------- */

clearSourceCache()
useReader(() => Promise.resolve({ ok: true, read: { text: CSV, complete: true } }))
{
  const view = await mount({
    items: [{ type: 'card', title: 'c', items: [{ type: 'tabs', tabs: [{ label: 'T', items: [{ type: 'table', source: { path: 'data/a.csv' } }] }] }] }],
  })
  check('嵌在 card/tabs 里的源表同样解析', view.text().includes('周二'))
  view.done()
}

let failed = 0
for (const [name, ok] of cases) {
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${name}`)
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
