/**
 * Runnable check for the spec → Markdown export (`pnpm verify:export`).
 *
 * Pure function, no DOM: every case asserts the shape a reader needs once the
 * card leaves the conversation — headings survive their level, tables stay
 * tables and escape pipes, code keeps its fence, quiz/forms stay readable.
 * Run with tsx.
 * @module scripts/verify-export
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { specToMarkdown } = await import(pathToFileURL(resolve(here, '../src/client/export.ts')).href)

const spec = {
  title: '导出样例',
  gap: 12,
  items: [
    { type: 'text', size: 'h2', content: '概览' },
    { type: 'text', size: 'muted', content: '次要说明' },
    {
      type: 'table',
      columns: ['组件', '状态'],
      rows: [['表格', 'a | b'], ['换行', 'x\ny']],
    },
    { type: 'keyvalue', pairs: [{ key: '版本', value: '0.9.0' }] },
    { type: 'list', items: ['纯字符串', { title: '带描述', desc: '说明文字' }] },
    { type: 'callout', tone: 'warning', title: '注意', content: '第一行\n第二行' },
    { type: 'code', lang: 'ts', code: 'const a = `x`\nconst b = a' },
    { type: 'diff', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] },
    { type: 'chart', kind: 'bars', data: [{ label: 'A', value: 3 }, { label: 'B', value: 5 }] },
    { type: 'steps', current: 1, steps: [{ title: '第一步' }, { title: '第二步', desc: '说明' }] },
    { type: 'quiz', question: '哪个对？', options: [{ label: '甲' }, { label: '乙' }], explanation: '甲对' },
    {
      type: 'file-tree',
      items: [{ name: 'src', type: 'dir', children: [{ name: 'index.ts', type: 'file' }] }],
    },
    { type: 'row', items: [{ type: 'badge', label: 'beta' }, { type: 'stat', label: '耗时', value: '1s', delta: '-20%' }] },
    { type: 'breadcrumb', items: ['首页', '设置'] },
  ],
}

const md = specToMarkdown(spec)

const cases = [
  ['标题按层级', md.includes('# 导出样例') && md.includes('## 概览')],
  ['弱化文本成引用', md.includes('> 次要说明')],
  ['表格保留并转义竖线', md.includes('| a \\| b |') && md.includes('| 换行 | x<br>y |')],
  ['keyvalue 成列表', md.includes('- **版本**: 0.9.0')],
  ['列表两种形态', md.includes('- 纯字符串') && md.includes('- **带描述** — 说明文字')],
  ['callout 每行都带引用前缀', md.includes('> **注意**') && md.includes('> 第二行')],
  ['代码围栏按内容加长', md.includes('```ts\nconst a = `x`')],
  ['diff 成 +/- 行', md.includes('--- a.ts') && md.includes('- old') && md.includes('+ new')],
  ['图表转表格', md.includes('| A | 3 |') && md.includes('| B | 5 |')],
  ['步骤带当前标记', md.includes('1. 第一步') && md.includes('2. 第二步 — 说明 ←')],
  ['quiz 保留选项与解析', md.includes('**哪个对？**') && md.includes('A. 甲') && md.includes('> 解析：甲对')],
  ['file-tree 嵌套', md.includes('- 📁 src') && md.includes('  - 📄 index.ts')],
  ['row 内联连接', md.includes('`beta` · **耗时** 1s (-20%)')],
  ['面包屑', md.includes('首页 › 设置')],
]

let failed = 0
for (const [name, ok] of cases) {
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${name}`)
}
if (failed > 0) {
  console.log('\n--- 实际输出 ---\n' + md)
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
