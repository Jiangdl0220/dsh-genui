/**
 * Runnable check for the workspace data binding (`pnpm verify:source`): the
 * pure parsers, the CSV/JSON → table/chart mappers, the caps and truncation
 * notes, the failure paths (no reader, host rejection, unknown format), and
 * the guard's acceptance of a `source`-only node. No DOM, no host: the reader
 * is a fake that returns authored text.
 * @module scripts/verify-source
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const {
  MAX_SOURCE_LINES, createWorkspaceReader, loadChartSource, loadTableSource,
  parseDelimited, sourceFormat, tableFromJson, tableFromRows,
} = await import(pathToFileURL(resolve(here, '../src/client/data-source.tsx')).href)
const { GENUI_LIMITS, repairGenuiSpec, validateGenuiSpec } = await import(
  pathToFileURL(resolve(here, '../src/client/guard.ts')).href
)
const { specToMarkdown } = await import(pathToFileURL(resolve(here, '../src/client/export.ts')).href)

/** Reader over authored text; records the path the node asked for. */
function readerOf(text, { complete = true, path } = {}) {
  const calls = []
  const reader = (sessionId, asked, signal) => {
    calls.push({ sessionId, path: asked, signal })
    return Promise.resolve({ ok: true, read: { text, complete: path === undefined ? complete : asked === path } })
  }
  reader.calls = calls
  return reader
}

const failing = (message) => () => Promise.resolve({ ok: false, message })
const never = new AbortController().signal

const cases = []
const check = (name, ok) => { cases.push([name, ok === true]) }

/* ---------- parsing ---------- */

const csv = 'name,note,value\r\n"a,1","line1\nline2",3\r\n"say ""hi""",,4\r\n'
const parsed = parseDelimited(csv, ',', MAX_SOURCE_LINES)
check('CSV: 引号内的分隔符与换行保持在一个字段里',
  parsed[1]?.[0] === 'a,1' && parsed[1]?.[1] === 'line1\nline2')
check('CSV: 双写引号还原为一个引号、CRLF 行尾被吃掉',
  parsed[2]?.[0] === 'say "hi"' && parsed[2]?.[1] === '' && parsed[2]?.[2] === '4')
check('CSV: 末尾空行不算数据行', parsed.length === 3)

const table = tableFromRows(parsed)
check('CSV → 表: 首行做表头，空表头给位置名',
  table.columns.join('|') === 'name|note|value' && table.rows.length === 2)
check('CSV → 表: 短行补齐到表宽', tableFromRows([['a', 'b'], ['1']]).rows[0]?.length === 2)
check('CSV → 表: 全空行被丢掉', tableFromRows([['a'], ['1'], ['', '']]).rows.length === 1)
check('CSV → 表: 行数受上限约束', (() => {
  const many = [['n'], ...Array.from({ length: GENUI_LIMITS.maxTableRows + 25 }, (_, i) => [String(i)])]
  return tableFromRows(many).rows.length === GENUI_LIMITS.maxTableRows
})())
check('CSV → 表: 空表头写占位名', tableFromRows([['a', ''], ['1', '2']]).columns[1] === '列2')

check('JSON → 表: 对象数组取并集列（首次出现顺序）',
  (() => {
    const t = tableFromJson([{ a: 1, b: 'x' }, { b: 'y', c: true }])
    return t.columns.join('|') === 'a|b|c' && t.rows[0]?.[2] === '' && t.rows[1]?.[2] === 'true'
  })())
check('JSON → 表: {columns, rows} 直接映射',
  (() => {
    const t = tableFromJson({ columns: ['a', 'b'], rows: [[1, 2]] })
    return t?.columns.join('|') === 'a|b' && t.rows[0]?.[0] === '1'
  })())
check('JSON → 表: 二维数组首行做表头', tableFromJson([['a', 'b'], [1, 2]])?.columns.join('|') === 'a|b')
check('JSON → 表: 认不出的形状返回 null', tableFromJson({ hello: 1 }) === null)

check('格式推断: 后缀优先，显式 format 覆盖',
  sourceFormat({ path: 'a/b.CSV' }) === 'csv'
  && sourceFormat({ path: 'x.tsv' }) === 'tsv'
  && sourceFormat({ path: 'x.json', format: 'csv' }) === 'csv'
  && sourceFormat({ path: 'x.txt' }) === null)

/* ---------- loads ---------- */

check('表: 指定路径读取并映射',
  await (async () => {
    const r = readerOf('a,b\n1,2\n', { path: 'data/sales.csv' })
    const out = await loadTableSource(r, 'S1', { path: 'data/sales.csv' }, never)
    return out.ok && out.value.columns.join('|') === 'a|b' && r.calls[0]?.path === 'data/sales.csv' && r.calls[0]?.sessionId === 'S1'
  })())

check('表: 文件未读完时给出截断说明',
  await (async () => {
    const out = await loadTableSource(readerOf('a\n1\n', { complete: false }), 'S1', { path: 'x.csv' }, never)
    return out.ok && typeof out.note === 'string' && out.note.includes('仅显示前')
  })())

check('表: 空数据行给说明而不是空表',
  await (async () => {
    const out = await loadTableSource(readerOf('a,b\n'), 'S1', { path: 'x.csv' }, never)
    return out.ok && out.note === '文件里没有数据行'
  })())

check('图: 默认第 1 列标签、第 2 列数值',
  await (async () => {
    const out = await loadChartSource(readerOf('day,ms\n周一,12\n周二,15\n'), 'S1', { path: 'r.csv' }, never)
    return out.ok && out.value.length === 2 && out.value[1]?.label === '周二' && out.value[1]?.value === 15
  })())

check('图: label/value 指定列名',
  await (async () => {
    const out = await loadChartSource(readerOf('ms,day\n12,周一\n'), 'S1', { path: 'r.csv', label: 'day', value: 'ms' }, never)
    return out.ok && out.value[0]?.label === '周一' && out.value[0]?.value === 12
  })())

check('图: 指定的列不存在时报错',
  await (async () => {
    const out = await loadChartSource(readerOf('a,b\n1,2\n'), 'S1', { path: 'r.csv', value: 'nope' }, never)
    return !out.ok && out.message.includes('nope')
  })())

check('图: 非数值行被丢弃并说明条数',
  await (async () => {
    const out = await loadChartSource(readerOf('d,v\n周?,abc\n周一,3\n'), 'S1', { path: 'r.csv' }, never)
    return out.ok && out.value.length === 1 && out.note?.includes('忽略 1 行')
  })())

check('图: 12,345 / 12% 这类单元格按数值解析',
  await (async () => {
    const out = await loadChartSource(readerOf('d,v\nx,"1,200"\ny,12%\n', { path: 'r.csv' }), 'S1', { path: 'r.csv' }, never)
    return out.ok && out.value[0]?.value === 1200 && out.value[1]?.value === 12
  })())

check('图: JSON [数字] 与 [{label,value}]',
  await (async () => {
    const a = await loadChartSource(readerOf('[3,5]'), 'S1', { path: 'd.json' }, never)
    const b = await loadChartSource(readerOf('{"data":[{"label":"x","value":7}]}'), 'S1', { path: 'd.json' }, never)
    return a.ok && b.ok && a.value[0]?.label === '#1' && a.value[1]?.value === 5 && b.value[0]?.label === 'x'
  })())

check('图: JSON 没有图表数据时报错',
  await (async () => {
    const out = await loadChartSource(readerOf('{"hello":1}'), 'S1', { path: 'd.json' }, never)
    return !out.ok && out.message.includes('没有图表数据')
  })())

check('图: JSON 语法错误带出解析信息',
  await (async () => {
    const out = await loadChartSource(readerOf('{oops'), 'S1', { path: 'd.json' }, never)
    return !out.ok && out.message.includes('JSON 解析失败')
  })())

check('图: 点数受上限约束并说明',
  await (async () => {
    const rows = ['d,v', ...Array.from({ length: GENUI_LIMITS.maxChartPoints + 10 }, (_, i) => `d${String(i)},${String(i)}`)]
    const out = await loadChartSource(readerOf(rows.join('\n')), 'S1', { path: 'r.csv' }, never)
    return out.ok && out.value.length === GENUI_LIMITS.maxChartPoints && out.note?.includes('数据点')
  })())

check('认不出后缀且没写 format 时报错',
  await (async () => {
    const out = await loadTableSource(readerOf('a\n1\n'), 'S1', { path: 'notes.txt' }, never)
    return !out.ok && out.message.includes('source.format')
  })())

check('宿主拒绝读取时把原因带到提示里',
  await (async () => {
    const out = await loadTableSource(failing('ENOENT: no such file'), 'S1', { path: 'x.csv' }, never)
    return !out.ok && out.message === 'ENOENT: no such file'
  })())

check('宿主没有工作区服务时优雅降级',
  await (async () => {
    const out = await loadTableSource(createWorkspaceReader(undefined), 'S1', { path: 'x.csv' }, never)
    return !out.ok && out.message.includes('工作区文件服务')
  })())

check('Remote 面正常时解析 {ok, value}',
  await (async () => {
    const remote = {
      workspaceFiles: {
        read: (sessionId, path, range) => Promise.resolve({ ok: true, value: { text: 'a\n1\n', lines: 2, eof: true, offset: range?.offset ?? 0 } }),
      },
    }
    const out = await loadTableSource(createWorkspaceReader(remote), 'S1', { path: 'x.csv' }, never)
    return out.ok && out.value.rows.length === 1
  })())

/* ---------- guard ---------- */

const sourceTable = { title: 't', items: [{ type: 'table', source: { path: 'data/a.csv' } }] }
const repaired = repairGenuiSpec(sourceTable)
const node = repaired?.items[0]
check('guard: 只有 source 的 table 不被丢掉',
  node?.type === 'table' && node.source?.path === 'data/a.csv' && node.columns.length === 0 && node.rows.length === 0)
check('guard: 只有 source 的 chart 不被丢掉',
  (() => {
    const out = repairGenuiSpec({ items: [{ type: 'chart', kind: 'line', source: { path: 'd.json' } }] })?.items[0]
    return out?.type === 'chart' && out.kind === 'line' && out.source?.path === 'd.json'
  })())
check('guard: source 的路径被裁剪且超长被截断',
  (() => {
    const long = repairGenuiSpec({ items: [{ type: 'table', source: { path: 'x'.repeat(GENUI_LIMITS.maxSourcePath + 50) } }] })?.items[0]
    return long?.type === 'table' && long.source?.path.length === GENUI_LIMITS.maxSourcePath
  })())
check('guard: 非法 source 退回内嵌形式（有 columns 就渲染表格）',
  (() => {
    const out = repairGenuiSpec({ items: [{ type: 'table', source: { path: 42 }, columns: ['a'], rows: [[1]] }] })?.items[0]
    return out?.type === 'table' && out.source === undefined && out.columns.join('|') === 'a'
  })())
check('guard: 既无 source 又无 columns 的 table 仍被丢掉',
  repairGenuiSpec({ items: [{ type: 'table' }] })?.items.length === 0)
check('validator: source 表通过校验', validateGenuiSpec(sourceTable).ok === true)
check('validator: 非法 source 被报错',
  validateGenuiSpec({ items: [{ type: 'table', source: { path: 42 } }] }).errors.some(e => e.includes('source')))
check('export: source 表导出成文件引用而不是空表',
  specToMarkdown(sourceTable).includes('data/a.csv') && !specToMarkdown(sourceTable).includes('| --- |'))
check('export: source 图导出成文件引用',
  specToMarkdown({ items: [{ type: 'chart', kind: 'line', source: { path: 'd.json' } }] }).includes('d.json'))

let failed = 0
for (const [name, ok] of cases) {
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${name}`)
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
