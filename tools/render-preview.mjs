/**
 * 生成 README 用的预览图（把标语墙按方块配色画成 PNG）。
 *
 * 用法：node tools/render-preview.mjs
 * 产出：docs/preview-cjk.png、docs/preview-mixed.png
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadData, generateSlogan } from '../src/node/generate.mjs'
import { encodePng } from './lib/pngwrite.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DOCS = join(ROOT, 'docs')

const data = loadData()
const colors = existsSync(join(ROOT, 'data', 'block-colors.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'data', 'block-colors.json'), 'utf8'))
  : {}

const hexToRgb = (hex) => {
  const h = (hex || '#808080').replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/**
 * @param {object} opts
 * @param {string} opts.text
 * @param {string} opts.bg
 * @param {string} opts.fg
 * @param {number} opts.px 每个方块画多少像素
 * @param {number} [opts.border]
 * @param {string} opts.out
 * @param {number} [opts.label] 预留
 */
function render (opts) {
  const r = generateSlogan({
    text: opts.text,
    bg: opts.bg,
    fg: opts.fg,
    border: opts.border ?? 2,
    spacing: opts.spacing ?? 1,
    lineGap: opts.lineGap ?? 1,
    align: opts.align ?? 'center',
    dotBlocks: opts.dotBlocks ?? 1
  })
  const { width, height, grid } = r.layout
  const px = opts.px
  const pad = 12
  const W = width * px + pad * 2
  const H = height * px + pad * 2
  const [br, bgc, bb] = hexToRgb(colors[r.bg.replace(/^minecraft:/, '')])
  const [fr, fg, fb] = hexToRgb(colors[r.fg.replace(/^minecraft:/, '')])
  const rgba = new Uint8Array(W * H * 4)

  // 背景（深色画布）
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = 0x14; rgba[i * 4 + 1] = 0x16; rgba[i * 4 + 2] = 0x1a; rgba[i * 4 + 3] = 255
  }
  const put = (x, y, c) => {
    const o = (y * W + x) * 4
    rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255
  }
  for (let by = 0; by < height; by++) {
    for (let bx = 0; bx < width; bx++) {
      const c = grid[by * width + bx] ? [fr, fg, fb] : [br, bgc, bb]
      for (let dy = 0; dy < px; dy++) {
        for (let dx = 0; dx < px; dx++) put(pad + bx * px + dx, pad + by * px + dy, c)
      }
    }
  }

  mkdirSync(DOCS, { recursive: true })
  const out = join(DOCS, opts.out)
  writeFileSync(out, encodePng(W, H, rgba))
  console.log(`  ${opts.out.padEnd(22)} ${width}×${height} 方块 → ${W}×${H}px  (${(readFileSync(out).length / 1024).toFixed(0)} KB)`)
  return out
}

console.log('生成预览图：')
render({ text: '科学技术是第一生产力', bg: 'red_concrete', fg: 'white_concrete', px: 7, border: 2, out: 'preview-cjk.png' })
render({ text: 'HELLO MINECRAFT 2026', bg: 'black_concrete', fg: 'lime_concrete', px: 5, border: 2, out: 'preview-ascii.png' })
render({ text: '好好学习\n天天向上', bg: 'blue_concrete', fg: 'yellow_concrete', px: 6, border: 2, spacing: 2, lineGap: 2, out: 'preview-multiline.png' })
console.log('完成。')
