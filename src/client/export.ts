/**
 * Card export: turn a rendered spec into something that survives leaving the
 * conversation — Markdown for docs/issues, the raw JSON spec for feeding back
 * to the model, and a PNG of the rendered card for chat/paste targets.
 *
 * Markdown is a pure function of the spec (deterministic, testable); PNG reads
 * the LIVE node because the rendered card carries computed styles the spec
 * does not (theme tokens, CSS-module classes). PNG therefore takes the same
 * route the browser already uses to draw the card: clone the subtree with its
 * computed styles inlined into a `foreignObject`, rasterize through an
 * `<img>`, and hand back a canvas blob.
 *
 * @module @jzk-mac/dsh-genui/client/export
 */
import type { GenuiNode, GenuiSpec } from './spec.ts'

/** Escape a table cell: pipes break the row, newlines break the table. */
function cell(value: string | number): string {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>')
}

/** Fence a code body with enough backticks that the body can never close it. */
function fence(body: string, lang?: string): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length))
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}${lang ?? ''}\n${body}\n${ticks}`
}

/** Inline shape of one node, used when it sits inside a row. */
function inline(node: GenuiNode): string {
  switch (node.type) {
    case 'text': return node.content
    case 'badge': return `\`${node.label}\``
    case 'stat': return `**${node.label}** ${node.value}${node.delta === undefined ? '' : ` (${node.delta})`}`
    case 'link': return node.href === undefined ? node.label : `[${node.label}](${node.href})`
    case 'progress': return `${node.label ?? '进度'} ${node.valueLabel ?? `${String(node.value)}%`}`
    case 'code': return `\`${node.code.split('\n')[0]}\``
    case 'avatar': return `@${node.name}`
    default: return block(node).replace(/\n+/g, ' ').trim()
  }
}

/** Bullet list for one node's inline form, or null when it renders nothing. */
function bullets(nodes: GenuiNode[]): string | null {
  const lines = nodes.map(inline).filter((s) => s.trim() !== '')
  return lines.length === 0 ? null : lines.map((s) => `- ${s}`).join('\n')
}

/** Nested bullet list from `{ name, type, children }` file-tree entries. */
function fileTree(node: Extract<GenuiNode, { type: 'file-tree' }>, depth = 0): string {
  return node.items.map((entry) => {
    const icon = entry.type === 'dir' ? '📁' : '📄'
    const head = `${'  '.repeat(depth)}- ${icon} ${entry.name}`
    return entry.children === undefined || entry.children.length === 0
      ? head
      : `${head}\n${fileTree({ ...node, items: entry.children }, depth + 1)}`
  }).join('\n')
}

/** One node as a Markdown block (may be several lines). */
function block(node: GenuiNode): string {
  switch (node.type) {
    case 'text':
      switch (node.size) {
        case 'h1': return `# ${node.content}`
        case 'h2': return `## ${node.content}`
        case 'h3': return `### ${node.content}`
        case 'muted': return `> ${node.content}`
        case 'caption': return `*${node.content}*`
        default: return node.content
      }
    case 'row': return node.items.map(inline).filter((s) => s.trim() !== '').join(' · ')
    case 'col':
    case 'grid': return node.items.map(block).filter((s) => s.trim() !== '').join('\n\n')
    case 'card':
      return [node.title === undefined ? '' : `**${node.title}**`, node.items.map(block).join('\n\n')]
        .filter((s) => s.trim() !== '').join('\n\n')
    case 'list':
      return node.items.map((item) => typeof item === 'string'
        ? `- ${item}`
        : `- **${item.title}**${item.desc === undefined ? '' : ` — ${item.desc}`}`).join('\n')
    case 'table': {
      const head = `| ${node.columns.map(cell).join(' | ')} |`
      const rule = `| ${node.columns.map(() => '---').join(' | ')} |`
      const body = node.rows.map((row) => `| ${row.map(cell).join(' | ')} |`).join('\n')
      return [head, rule, body].filter((s) => s !== '').join('\n')
    }
    case 'keyvalue': return node.pairs.map((p) => `- **${p.key}**: ${p.value}`).join('\n')
    case 'callout': {
      const head = node.title === undefined ? '' : `**${node.title}**\n`
      return `> ${head}${node.content}`.replace(/\n/g, '\n> ').replace(/> $/, '>')
    }
    case 'code': return fence(node.code, node.lang)
    case 'json': return fence(JSON.stringify(node.value, null, 2), 'json')
    case 'mermaid': return fence(node.code, 'mermaid')
    case 'diff':
      return fence(node.diffs.map((d) => {
        const head = `--- ${d.path}`
        const old = d.oldText === null || d.oldText === undefined ? [] : d.oldText.split('\n').map((l) => `- ${l}`)
        const next = d.newText === null || d.newText === undefined ? [] : d.newText.split('\n').map((l) => `+ ${l}`)
        return [head, ...old, ...next].join('\n')
      }).join('\n'), 'diff')
    case 'chart': {
      const columns = ['label', ...(node.series === undefined ? ['value'] : node.series.map((s) => s.label || 'value'))]
      const rows = node.series === undefined
        ? node.data.map((d) => [d.label, d.value])
        : node.data.map((d, i) => [d.label, ...node.series!.map((s) => s.data[i]?.value ?? '')])
      const table: Extract<GenuiNode, { type: 'table' }> = { type: 'table', columns, rows }
      return `${node.kind ?? 'bars'} 图：\n\n${block(table)}`
    }
    case 'heatmap': {
      const table: Extract<GenuiNode, { type: 'table' }> = {
        type: 'table',
        columns: ['', ...node.columns],
        rows: node.rows.map((row, ri) => [
          row,
          ...node.columns.map((_, ci) => {
            const v = node.values[ri]?.[ci]
            return typeof v === 'number' && Number.isFinite(v) ? `${String(v)}${node.unit ?? ''}` : '—'
          }),
        ]),
      }
      return [node.label === undefined ? '' : `**${node.label}**`, block(table)].filter((s) => s !== '').join('\n\n')
    }
    case 'gantt':
      return [
        node.title === undefined ? '' : `**${node.title}**`,
        ...node.items.map((item) => `- ${item.label}：${String(item.start)} – ${String(item.end)}${node.unit ?? ''}${item.group === undefined ? '' : `（${item.group}）`}`),
      ].filter((s) => s !== '').join('\n')
    case 'plot':
      return [
        node.title === undefined ? '' : `**${node.title}**`,
        ...node.series.map((s) => `- ${s.label ?? s.expr}：\`${s.expr}\``),
        `- 范围：x ∈ [${String(node.xMin ?? -5)}, ${String(node.xMax ?? 5)}]`,
      ].filter((s) => s !== '').join('\n')
    case 'steps':
      return node.steps.map((step, i) => {
        const mark = node.current !== undefined && i === node.current ? ' ←' : ''
        return `${String(i + 1)}. ${step.title}${step.desc === undefined ? '' : ` — ${step.desc}`}${mark}`
      }).join('\n')
    case 'timeline':
      return node.items.map((item) => `- ${item.time === undefined ? '' : `**${item.time}** `}${item.title}${item.desc === undefined ? '' : ` — ${item.desc}`}`).join('\n')
    case 'stat': return bullets([node]) ?? ''
    case 'badge': return `\`${node.label}\``
    case 'progress': return `${node.label ?? '进度'}：${node.valueLabel ?? `${String(node.value)}%`}`
    case 'link': return node.href === undefined ? node.label : `[${node.label}](${node.href})`
    case 'divider': return '---'
    case 'spacer': return ''
    case 'avatar': return `@${node.name}`
    case 'tabs':
      return node.tabs.map((tab) => `### ${tab.label}\n\n${tab.items.map(block).join('\n\n')}`).join('\n\n')
    case 'accordion':
      return node.items.map((item) => `**${item.title}**\n\n${item.items.map(block).join('\n\n')}`).join('\n\n')
    case 'file-tree': return fileTree(node)
    case 'breadcrumb': return node.items.join(' › ')
    case 'scene3d':
      return [
        node.title === undefined ? '' : `**${node.title}**`,
        `${String(node.meshes.length)} 个网格：${node.meshes.map((m) => `${m.shape}${m.color === undefined ? '' : ` ${m.color}`}`).join('、')}`,
      ].filter((s) => s !== '').join('\n')
    case 'quiz':
      return [
        `**${node.question}**`,
        ...node.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o.label}`),
        node.explanation === undefined ? '' : `> 解析：${node.explanation}`,
      ].filter((s) => s !== '').join('\n')
    case 'radio':
      return [`**${node.label ?? '选择'}**`, ...node.options.map((o, i) => `${i === node.selected ? '- [x]' : '- [ ]'} ${o}`)].join('\n')
    case 'checkbox': return `${node.checked === true ? '- [x]' : '- [ ]'} ${node.label}`
    case 'switch': return `- ${node.label}：${node.checked === true ? '开' : '关'}`
    case 'select': return `**${node.label ?? '选择'}**：${node.options.map((o, i) => i === node.selected ? `**${o}**` : o).join(' / ')}`
    case 'input':
    case 'textarea': return `**${node.label ?? '输入'}**：\`${node.value ?? node.placeholder ?? ''}\``
    case 'slider': return `**${node.label ?? '数值'}**：${String(node.value ?? node.min ?? 0)}（${String(node.min ?? 0)}–${String(node.max ?? 100)}）`
    case 'button': return `[${node.label}]`
    case 'submit': return `[${node.label}]`
    case 'copy': return node.text
    default: {
      // Unknown/custom node: never lose content — fall back to its text-ish
      // fields, then to the raw shape.
      const loose = node as { content?: unknown; label?: unknown; title?: unknown }
      const text = [loose.title, loose.label, loose.content].find((v) => typeof v === 'string')
      return typeof text === 'string' ? text : fence(JSON.stringify(node, null, 2), 'json')
    }
  }
}

/** Convert a spec to Markdown: title as `#`, then one block per root item. */
export function specToMarkdown(spec: GenuiSpec): string {
  return [
    spec.title === undefined || spec.title === '' ? '' : `# ${spec.title}`,
    ...spec.items.map(block),
  ].filter((s) => s.trim() !== '').join('\n\n')
}

/** Copy text to the clipboard, falling back to a hidden textarea when the
 * async Clipboard API is unavailable (non-secure origins, older webviews). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

/** Copy every computed style of `from` onto `to`, recursively. */
function inlineStyles(from: Element, to: Element): void {
  const computed = getComputedStyle(from)
  const css: string[] = []
  for (let i = 0; i < computed.length; i += 1) {
    const name = computed.item(i)
    css.push(`${name}:${computed.getPropertyValue(name)};`)
  }
  to.setAttribute('style', css.join(''))
  const fromKids = from.children
  const toKids = to.children
  for (let i = 0; i < fromKids.length && i < toKids.length; i += 1) {
    const source = fromKids[i]
    const target = toKids[i]
    if (source === undefined || target === undefined) continue
    inlineStyles(source, target)
  }
}

/**
 * Rasterize a rendered card to a PNG blob.
 *
 * The clone keeps the card's real widths (the caller passes the live node, so
 * `getBoundingClientRect` is measurable), and computed styles are inlined
 * because the SVG image cannot see the page's stylesheets.
 * @param node - the live rendered card element.
 * @param scale - device pixel ratio multiplier (2 = retina-ish output).
 * @returns the PNG blob, or null when rasterization is unavailable.
 */
export async function cardToPng(node: HTMLElement, scale = 2): Promise<Blob | null> {
  try {
    const rect = node.getBoundingClientRect()
    const width = Math.max(1, Math.ceil(rect.width))
    const height = Math.max(1, Math.ceil(rect.height))
    const clone = node.cloneNode(true) as HTMLElement
    // Styles are walked in parallel with the source, so it must happen BEFORE
    // the export bar is dropped from the clone (removing a child would shift
    // every later index).
    inlineStyles(node, clone)
    // The export bar is chrome, not content: it must not appear in the image.
    for (const chrome of clone.querySelectorAll('[data-genui-export-ui]')) chrome.remove()
    clone.style.margin = '0'
    clone.style.width = `${String(width)}px`
    clone.style.height = `${String(height)}px`
    // Documents inside a foreignObject must be namespace-qualified and
    // self-contained; the card's own background travels with the inline styles.
    const wrapper = document.createElement('div')
    wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
    wrapper.style.width = `${String(width)}px`
    wrapper.style.height = `${String(height)}px`
    wrapper.appendChild(clone)

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(wrapper)}</foreignObject></svg>`
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    const image = new Image()
    image.width = width
    image.height = height
    await new Promise<void>((resolve, reject) => {
      image.onload = () => { resolve() }
      image.onerror = () => { reject(new Error('genui: card snapshot failed to decode')) }
      image.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = width * scale
    canvas.height = height * scale
    const context = canvas.getContext('2d')
    if (context === null) return null
    context.scale(scale, scale)
    context.drawImage(image, 0, 0)
    return await new Promise<Blob | null>((resolve) => { canvas.toBlob((blob) => { resolve(blob) }, 'image/png') })
  } catch {
    return null
  }
}

/** Hand a blob to the user as a download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoke on the next frame so the click has already been dispatched.
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}
