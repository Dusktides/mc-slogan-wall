/**
 * 量化诊断：直接量出「实际边距」与「相邻字形之间的实际空格数」，
 * 用于核对排版参数是否符合预期，也可作为回归测试的依据。
 *
 * 用法：node tools/measure.mjs
 */
import { loadData, generateSlogan } from '../src/node/generate.mjs'

const data = loadData()

function margins (layout) {
  const { width, height, grid } = layout
  let left = width
  let right = -1
  let top = height
  let bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!grid[y * width + x]) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  return { left, right: width - 1 - right, top, bottom: height - 1 - bottom }
}

function gaps (layout, lineIndex = 0) {
  const boxes = layout.inkBoxes.filter((b) => b.line === lineIndex)
  const out = []
  for (let i = 1; i < boxes.length; i++) {
    out.push({
      between: `${String.fromCodePoint(boxes[i - 1].cp ?? 32)}|${String.fromCodePoint(boxes[i].cp ?? 32)}`,
      gap: boxes[i].x0 - boxes[i - 1].x1,
      kinds: `${boxes[i - 1].source}+${boxes[i].source}`
    })
  }
  return out
}

function summarize (label, opts) {
  const r = generateSlogan(opts)
  const m = margins(r.layout)
  const g = gaps(r.layout)
  const byKind = new Map()
  for (const item of g) {
    const key = item.kinds.replace('mojangles', '英').replace('unifont', '汉')
    if (!byKind.has(key)) byKind.set(key, new Set())
    byKind.get(key).add(item.gap)
  }
  console.log(`\n── ${label}`)
  console.log(`   尺寸 ${r.layout.width}×${r.layout.height}  latinDots=${r.latinDots}  spacing=${r.spacing}(${r.spacingMode})  border=${r.border}`)
  console.log(`   实际边距  左 ${m.left}  右 ${m.right}  上 ${m.top}  下 ${m.bottom}`)
  const parts = []
  for (const [k, v] of byKind) parts.push(`${k} = ${[...v].join('/')} 格`)
  console.log(`   字间实际空格  ${parts.join('   ')}`)
  return { r, m, gaps: g }
}

console.log('='.repeat(72))
console.log('修复后的行为（gap 模式：字间距 = 相邻字形墨迹之间的真实空格数）')
console.log('='.repeat(72))

summarize('纯汉字 · spacing=0 · border=0', { text: '科学技术', spacing: 0, spacingMode: 'gap', border: 0 })
summarize('纯汉字 · spacing=1 · border=0', { text: '科学技术', spacing: 1, spacingMode: 'gap', border: 0 })
summarize('纯字母 · spacing=0 · border=0', { text: 'Hello', spacing: 0, spacingMode: 'gap', border: 0 })
summarize('纯字母 · spacing=1 · border=0', { text: 'Hello', spacing: 1, spacingMode: 'gap', border: 0 })
summarize('汉字+字母 · spacing=1 · border=0', { text: '科学ABC', spacing: 1, spacingMode: 'gap', border: 0 })
summarize('字母+汉字 · spacing=1 · border=0', { text: 'ABC科学', spacing: 1, spacingMode: 'gap', border: 0 })
summarize('多行不居中会怎样 · align=center', { text: '标语\nMinecraft 标语', spacing: 1, border: 1, align: 'center' })

console.log('\n' + '='.repeat(72))
console.log('对比：advance 模式（叠加在原版字体字距上，即修复前的语义）')
console.log('='.repeat(72))
summarize('纯汉字 · spacing=0 · advance', { text: '科学技术', spacing: 0, spacingMode: 'advance', border: 0 })
summarize('纯字母 · spacing=0 · advance', { text: 'Hello', spacing: 0, spacingMode: 'advance', border: 0 })
