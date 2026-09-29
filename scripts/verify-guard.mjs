/**
 * Runnable check for the guard's handling of the newer component types
 * (`pnpm verify:guard`): heatmap and gantt must be repaired (caps, number
 * clamping, normalised bars, holes kept as holes) and must be accepted by the
 * validator instead of being reported as unknown types.
 * @module scripts/verify-guard
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { GENUI_LIMITS, repairGenuiSpec, validateGenuiSpec } = await import(
  pathToFileURL(resolve(here, '../src/client/guard.ts')).href
)

const heatmap = {
  title: 'H',
  items: [{
    type: 'heatmap',
    rows: ['周一', '周二'],
    columns: ['上午', '下午'],
    // A missing cell (null) and a short row must both survive as holes.
    values: [[1, null], [3]],
    unit: '次',
    label: '请求量',
  }],
}

const gantt = {
  title: 'G',
  items: [{
    type: 'gantt',
    items: [
      { label: '设计', start: 5, end: 2 }, // backwards on purpose
      { label: '开发', start: 2, end: 9, group: '阶段一', color: '#ff0000' },
      { label: '', start: 0, end: 1 }, // dropped: empty label
    ],
    unit: '天',
  }],
}

const repairedHeatmap = repairGenuiSpec(heatmap)
const repairedGantt = repairGenuiSpec(gantt)
const heat = repairedHeatmap?.items[0]
const bars = repairedGantt?.items[0]

const cases = [
  ['heatmap 通过校验', validateGenuiSpec(heatmap).ok],
  ['gantt 通过校验', validateGenuiSpec(gantt).ok],
  ['heatmap 保留轴标签与单位', heat?.type === 'heatmap' && heat.rows[0] === '周一' && heat.unit === '次'],
  ['heatmap 缺值变成空洞（NaN 而非 0）', heat?.type === 'heatmap' && Number.isNaN(heat.values[0]?.[1])],
  ['heatmap 短行不补齐也不报错', heat?.type === 'heatmap' && heat.values[1]?.length === 1],
  ['gantt 反向区间被归一化', bars?.type === 'gantt' && bars.items[0]?.start === 2 && bars.items[0]?.end === 5],
  ['gantt 空 label 仍保留（与 timeline 的修复规则一致）', bars?.type === 'gantt' && bars.items.length === 3],
  ['gantt 保留 group 与合法颜色', bars?.type === 'gantt' && bars.items[1]?.group === '阶段一' && bars.items[1]?.color === '#ff0000'],
  ['gantt 超过上限被截断', (() => {
    const many = { items: [{ type: 'gantt', items: Array.from({ length: GENUI_LIMITS.maxGanttItems + 10 }, (_, i) => ({ label: `t${String(i)}`, start: i, end: i + 1 })) }] }
    const out = repairGenuiSpec(many)?.items[0]
    return out?.type === 'gantt' && out.items.length === GENUI_LIMITS.maxGanttItems
  })()],
  ['heatmap 缺字段被拒绝', repairGenuiSpec({ items: [{ type: 'heatmap', rows: ['a'] }] })?.items.length === 0],
]

let failed = 0
for (const [name, ok] of cases) {
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${name}`)
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
