/**
 * Workspace data binding for the data nodes: a `source` on `table` / `chart`
 * loads the values from a workspace file at RENDER time instead of embedding
 * them in the reply — a 200-row table costs the model a 40-character node
 * rather than 20 kB of fence.
 *
 * Three layers, deliberately separated:
 * - the pure core (`parseDelimited` + the table/chart mappers + caps) is
 *   host-independent and unit tested;
 * - the **reader** is installed by the client entry when the host exposes the
 *   `workspaceFiles` Remote namespace, and is absent otherwise;
 * - the React hook is a thin bounded cache in front of the core.
 *
 * Every failure degrades to a one-line note INSIDE the block: an unreadable
 * file must never take the surrounding reply down, and a missing reader (a
 * host without the workspace service) must degrade the same way.
 * @module @jzk-mac/dsh-genui/client/data-source
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { GENUI_LIMITS } from './guard.ts'
import type { GenuiChartDatum, GenuiSource } from './spec.ts'

/** Lines requested from the host per read; the mappers cap below this. */
export const MAX_SOURCE_LINES = 400

/** One host page of file text. */
export interface GenuiSourceRead {
  /** Decoded text of the page (line-based page, newest read starts at 0). */
  text: string
  /** True when the host page reached EOF — false means the file is longer. */
  complete: boolean
}

/**
 * Reads a workspace file for one session. Implemented over the host's
 * `workspaceFiles` Remote; a missing namespace yields a reader that reports
 * the condition instead of throwing.
 */
export type GenuiSourceReader = (
  sessionId: string,
  path: string,
  signal: AbortSignal,
) => Promise<{ ok: true; read: GenuiSourceRead } | { ok: false; message: string }>

/** Success or a human-readable failure. Never throws. */
export type SourceOutcome<T> = { ok: true; value: T; note?: string } | { ok: false; message: string }

/** Resolved table payload. */
export interface SourceTable {
  columns: string[]
  rows: Array<Array<string | number>>
}

/* ---------------- reader registry ---------------- */

let activeReader: GenuiSourceReader | undefined

/**
 * Install the process-wide reader. Returns a release function that clears the
 * slot only when this reader is still the installed one, so a stopped fiber
 * can never unbind a newer installation.
 */
export function setGenuiSourceReader(reader: GenuiSourceReader | undefined): () => void {
  activeReader = reader
  return () => {
    if (activeReader === reader) activeReader = undefined
  }
}

/* ---------------- host Remote face ---------------- */

/** The slice of the Client Remote face this module calls (declared locally:
 * the workspace-files package is not a dependency of this plugin). */
interface WorkspaceFilesRemoteFace {
  read(
    sessionId: string,
    path: string,
    range: { offset?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; value: { text: string; lines: number; eof: boolean } }
    | { ok: false; error?: unknown }
  >
}

interface RemoteFace {
  workspaceFiles?: WorkspaceFilesRemoteFace
}

/** The Client Remote shape the reader needs (exported for the entry's cast). */
export type GenuiWorkspaceRemote = RemoteFace

/** One-line description of a Remote failure (`{code, message}` or anything). */
function remoteMessage(error: unknown): string {
  if (error === undefined || error === null) return '宿主拒绝了读取请求'
  if (typeof error === 'string') return error
  if (typeof error === 'object') {
    const e = error as { message?: unknown; code?: unknown }
    if (typeof e.message === 'string' && e.message !== '') return e.message
    if (typeof e.code === 'string') return e.code
  }
  return '宿主拒绝了读取请求'
}

/**
 * Build the reader over one Client Remote face. The Host resolves the path
 * against the session's workspace and enforces its own caps, so this module
 * only bounds the page it asks for.
 */
export function createWorkspaceReader(remote: RemoteFace | undefined): GenuiSourceReader {
  const face = remote?.workspaceFiles
  if (face === undefined) {
    return async () => ({ ok: false, message: '当前宿主没有工作区文件服务' })
  }
  return async (sessionId, path, signal) => {
    try {
      const result = await face.read(sessionId, path, { offset: 0, limit: MAX_SOURCE_LINES }, signal)
      if (!result.ok) return { ok: false, message: remoteMessage(result.error) }
      const value = result.value
      return { ok: true, read: { text: value.text, complete: value.eof === true } }
    } catch (err) {
      if (signal.aborted) return { ok: false, message: '读取超时或被取消' }
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }
}

/* ---------------- format + parsing (pure) ---------------- */

/** Resolved source format: explicit `format` wins, otherwise the extension. */
export function sourceFormat(source: GenuiSource): 'csv' | 'tsv' | 'json' | null {
  if (source.format !== undefined) return source.format
  const name = source.path.toLowerCase()
  if (name.endsWith('.csv')) return 'csv'
  if (name.endsWith('.tsv') || name.endsWith('.tab')) return 'tsv'
  if (name.endsWith('.json')) return 'json'
  return null
}

/**
 * Parse one delimited text into a row matrix: RFC-4180 quoting (`""` escapes a
 * quote, a quoted field may contain the delimiter and newlines), CRLF or LF
 * row ends, and a hard row cap so a pathological file cannot grow memory.
 */
export function parseDelimited(text: string, delimiter: string, maxRows: number): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"' && field === '') { quoted = true; i += 1; continue }
    if (ch === delimiter) { row.push(field); field = ''; i += 1; continue }
    if (ch === '\r') { i += 1; continue }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      if (rows.length >= maxRows) return rows
      continue
    }
    field += ch
    i += 1
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  // A trailing blank line (very common in hand-written CSV) is not a data row.
  const last = rows[rows.length - 1]
  if (last !== undefined && last.length <= 1 && (last[0] ?? '').trim() === '') rows.pop()
  return rows.slice(0, maxRows)
}

/** Header cell for column `i`: the file's text, or a positional placeholder. */
const headerCell = (cells: string[], i: number): string => {
  const raw = (cells[i] ?? '').trim()
  return raw === '' ? `列${i + 1}` : raw
}

/** CSV/TSV rows → table: the first row is the header, blank headers get a
 * positional name, short rows pad to the widest cell count. */
export function tableFromRows(rows: string[][]): SourceTable {
  const head = rows[0] ?? []
  const body = rows.slice(1)
  const width = Math.min(
    Math.max(head.length, ...body.map(r => r.length), 1),
    GENUI_LIMITS.maxTableCols,
  )
  const columns = Array.from({ length: width }, (_, i) => headerCell(head, i))
  const kept = body
    .filter(r => r.some(cell => cell.trim() !== ''))
    .slice(0, GENUI_LIMITS.maxTableRows)
    .map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''))
  return { columns, rows: kept }
}

/** JSON value → table. Accepted shapes: `{columns, rows}`, an array of arrays
 * (first array is the header), or an array of objects (union of their keys,
 * in first-seen order). Anything else returns null. */
export function tableFromJson(value: unknown): SourceTable | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return { columns: [], rows: [] }
    if (Array.isArray(value[0])) {
      return tableFromRows(value.map(row => (Array.isArray(row) ? row.map(cell => String(cell ?? '')) : [String(row ?? '')])))
    }
    const objects = value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row))
    if (objects.length === 0) return null
    const columns: string[] = []
    for (const row of objects) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
    const kept = columns.slice(0, GENUI_LIMITS.maxTableCols)
    const rows = objects.slice(0, GENUI_LIMITS.maxTableRows).map(row => kept.map(key => {
      const cell = row[key]
      if (cell === null || cell === undefined) return ''
      if (typeof cell === 'number') return cell
      return typeof cell === 'string' ? cell : String(cell)
    }))
    return { columns: kept, rows }
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as { columns?: unknown; rows?: unknown }
    if (Array.isArray(record.columns) && Array.isArray(record.rows)) {
      const head = record.columns.map(cell => String(cell ?? ''))
      const body = record.rows
        .filter((row): row is unknown[] => Array.isArray(row))
        .map(row => row.map(cell => (cell === null || cell === undefined ? '' : typeof cell === 'number' || typeof cell === 'boolean' ? cell : String(cell))))
      return tableFromRows([head, ...body.map(row => row.map(cell => String(cell)))])
    }
  }
  return null
}

/** CSV/TSV rows → chart data. `label`/`value` name the columns; the defaults
 * are the first and second column. Non-numeric value cells are dropped (the
 * caller reports how many). */
function chartFromRows(rows: string[][], label?: string, value?: string): SourceOutcome<{ data: GenuiChartDatum[]; dropped: number }> {
  const head = rows[0] ?? []
  const labelAt = label === undefined ? 0 : head.indexOf(label)
  const valueAt = value === undefined ? 1 : head.indexOf(value)
  if (label !== undefined && labelAt < 0) return { ok: false, message: `CSV 里没有列「${label}」` }
  if (value !== undefined && valueAt < 0) return { ok: false, message: `CSV 里没有列「${value}」` }
  const data: GenuiChartDatum[] = []
  let dropped = 0
  for (const row of rows.slice(1)) {
    if (row.every(cell => (cell ?? '').trim() === '')) continue
    const raw = (row[valueAt] ?? '').trim().replace(/[,%]/g, '')
    const n = raw === '' ? Number.NaN : Number(raw)
    if (!Number.isFinite(n)) { dropped += 1; continue }
    const text = (row[labelAt] ?? '').trim()
    data.push({ label: text === '' ? `#${data.length + 1}` : text, value: n })
    if (data.length >= GENUI_LIMITS.maxChartPoints) break
  }
  return { ok: true, value: { data, dropped } }
}

/** JSON value → chart data. Accepted shapes: an array of `{label, value}`, an
 * array of numbers (label = 1-based index), or `{data: [...]}`. */
function chartFromJson(value: unknown): GenuiChartDatum[] | null {
  const list = Array.isArray(value)
    ? value
    : (typeof value === 'object' && value !== null && Array.isArray((value as { data?: unknown }).data))
      ? (value as { data: unknown[] }).data
      : null
  if (list === null) return null
  const data: GenuiChartDatum[] = []
  for (const entry of list) {
    if (typeof entry === 'number') {
      if (Number.isFinite(entry)) data.push({ label: `#${data.length + 1}`, value: entry })
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { label?: unknown; value?: unknown }
    const n = Number(record.value)
    if (!Number.isFinite(n)) continue
    data.push({
      label: record.label === undefined || record.label === null ? `#${data.length + 1}` : String(record.label),
      value: n,
    })
    if (data.length >= GENUI_LIMITS.maxChartPoints) break
  }
  return data
}

/* ---------------- loads ---------------- */

async function read(
  reader: GenuiSourceReader,
  sessionId: string,
  source: GenuiSource,
  signal: AbortSignal,
): Promise<SourceOutcome<{ text: string; complete: boolean }>> {
  const format = sourceFormat(source)
  if (format === null) {
    return { ok: false, message: `认不出「${source.path}」的格式，请在 source.format 里写 csv / tsv / json` }
  }
  const result = await reader(sessionId, source.path, signal)
  if (!result.ok) return { ok: false, message: result.message }
  // JSON is parsed as a whole document, so a partial page can never be used
  // — say so instead of surfacing a syntax error from the cut.
  if (format === 'json' && !result.read.complete) {
    return { ok: false, message: `JSON 文件超过 ${MAX_SOURCE_LINES} 行（被截断），请改用 CSV 或缩小文件` }
  }
  return { ok: true, value: { text: result.read.text, complete: result.read.complete } }
}

/** Load a workspace file and map it to `{columns, rows}`. */
export async function loadTableSource(
  reader: GenuiSourceReader,
  sessionId: string,
  source: GenuiSource,
  signal: AbortSignal,
): Promise<SourceOutcome<SourceTable>> {
  const format = sourceFormat(source)
  const page = await read(reader, sessionId, source, signal)
  if (!page.ok) return page
  let table: SourceTable | null
  if (format === 'json') {
    try {
      table = tableFromJson(JSON.parse(page.value.text))
    } catch (err) {
      return { ok: false, message: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` }
    }
  } else {
    table = tableFromRows(parseDelimited(page.value.text, format === 'tsv' ? '\t' : ',', MAX_SOURCE_LINES))
  }
  if (table === null) return { ok: false, message: '文件内容不是表格（支持 CSV/TSV、对象数组、二维数组或 {columns, rows}）' }
  const capped = !page.value.complete || table.rows.length >= GENUI_LIMITS.maxTableRows
  const note = capped
    ? `仅显示前 ${GENUI_LIMITS.maxTableRows} 行（文件更长）`
    : table.rows.length === 0 ? '文件里没有数据行' : undefined
  return {
    ok: true,
    value: table,
    ...(note === undefined ? {} : { note }),
  }
}

/** Load a workspace file and map it to `chart` data. */
export async function loadChartSource(
  reader: GenuiSourceReader,
  sessionId: string,
  source: GenuiSource,
  signal: AbortSignal,
): Promise<SourceOutcome<GenuiChartDatum[]>> {
  const format = sourceFormat(source)
  const page = await read(reader, sessionId, source, signal)
  if (!page.ok) return page
  let data: GenuiChartDatum[]
  let dropped = 0
  let capped = false
  if (format === 'json') {
    try {
      const mapped = chartFromJson(JSON.parse(page.value.text))
      if (mapped === null) return { ok: false, message: 'JSON 里没有图表数据（支持 [{label,value}] 或 [数字]）' }
      data = mapped
      capped = mapped.length >= GENUI_LIMITS.maxChartPoints
    } catch (err) {
      return { ok: false, message: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` }
    }
  } else {
    const mapped = chartFromRows(parseDelimited(page.value.text, format === 'tsv' ? '\t' : ',', MAX_SOURCE_LINES), source.label, source.value)
    if (!mapped.ok) return mapped
    data = mapped.value.data
    dropped = mapped.value.dropped
    capped = data.length >= GENUI_LIMITS.maxChartPoints
  }
  const reasons: string[] = []
  if (!page.value.complete || capped) reasons.push(`仅显示前 ${GENUI_LIMITS.maxChartPoints} 个数据点（文件更长）`)
  if (dropped > 0) reasons.push(`忽略 ${dropped} 行非数值数据`)
  if (data.length === 0) reasons.push('文件里没有可绘制的数据')
  return {
    ok: true,
    value: data,
    ...(reasons.length === 0 ? {} : { note: reasons.join('；') }),
  }
}

/* ---------------- React binding ---------------- */

/** Session id the block is rendered in; absent outside a session. */
export const GenuiSessionContext = createContext<string | undefined>(undefined)

/** Provide the owning session to the data nodes below `children`. */
export function GenuiSessionProvider({ sessionId, children }: { sessionId: string | undefined; children: ReactNode }) {
  if (sessionId === undefined) return <>{children}</>
  return <GenuiSessionContext.Provider value={sessionId}>{children}</GenuiSessionContext.Provider>
}

/** Cache key: everything that changes the load result. */
function sourceCacheKey(sessionId: string | undefined, source: GenuiSource): string {
  return [sessionId ?? '-', source.path, source.format ?? '', source.label ?? '', source.value ?? ''].join('\u0000')
}

const CACHE_LIMIT = 64
const cache = new Map<string, unknown>()

/** Test seam: drop every cached load. */
export function clearSourceCache(): void {
  cache.clear()
  inFlight.clear()
}

function remember(key: string, value: unknown): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

/** Reads in progress, by cache key: the panel dock and the tool card render
 * the same spec at the same time, and a source must be read once, not twice. */
const inFlight = new Map<string, Promise<SourceOutcome<unknown>>>()

/** Give up on a wedged read; the node then reports a timeout instead of
 * showing a spinner that never ends. */
const READ_TIMEOUT_MS = 30_000

/**
 * Load through the installed reader for one session/source pair, deduplicating
 * concurrent loads of the same key. A missing reader or session resolves to a
 * failure outcome rather than a rejection, so the caller only branches on `ok`.
 */
function load(
  key: string,
  sessionId: string | undefined,
  source: GenuiSource,
  kind: 'table' | 'chart',
): Promise<SourceOutcome<unknown>> {
  const reader = activeReader
  if (reader === undefined) return Promise.resolve({ ok: false, message: '当前宿主没有工作区文件服务' })
  if (sessionId === undefined) return Promise.resolve({ ok: false, message: '不在会话里，无法读取工作区文件' })
  const pending = inFlight.get(key)
  if (pending !== undefined) return pending
  const promise = kind === 'table'
    ? loadTableSource(reader, sessionId, source, AbortSignal.timeout(READ_TIMEOUT_MS))
    : loadChartSource(reader, sessionId, source, AbortSignal.timeout(READ_TIMEOUT_MS))
  inFlight.set(key, promise)
  void promise.then(() => { if (inFlight.get(key) === promise) inFlight.delete(key) })
  return promise
}

/**
 * Resolve one `source` for rendering: `null` while the first load is in
 * flight, then the outcome (cached per session+path+columns so a re-render,
 * a panel update or a scroll-remount does not re-read the file). Only
 * successes are cached — a failed read retries on the next mount.
 */
export function useSource<T>(sessionId: string | undefined, source: GenuiSource | undefined, kind: 'table' | 'chart'): SourceOutcome<T> | null {
  const key = source === undefined ? null : `${kind}\u0000${sourceCacheKey(sessionId, source)}`
  const [outcome, setOutcome] = useState<SourceOutcome<T> | null>(() => {
    if (key === null) return null
    return (cache.get(key) as SourceOutcome<T> | undefined) ?? null
  })
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (key === null || source === undefined) return
    const hit = cache.get(key) as SourceOutcome<T> | undefined
    if (hit !== undefined) {
      setOutcome(hit)
      return
    }
    let alive = true
    void loadRef.current(key, sessionId, source, kind).then((result) => {
      if (!alive) return
      if (result.ok) remember(key, result)
      setOutcome(result as SourceOutcome<T>)
    })
    return () => { alive = false }
  }, [key, kind, sessionId, source])
  return outcome
}

/** Session id of the surrounding block (undefined outside a session). */
export function useGenuiSession(): string | undefined {
  return useContext(GenuiSessionContext)
}
