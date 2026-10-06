#!/usr/bin/env node
/**
 * Minecraft 标语投影生成工具 —— 命令行入口
 *
 *   node src/cli.mjs --text "HELLO WORLD" --out hello.litematic
 *   node src/cli.mjs --text "科学技术是第一生产力" --version 26.3 --preview
 *   node src/cli.mjs --list-blocks red --version 1.20.4
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { generateSlogan, loadData } from './node/generate.mjs'
import { renderAscii } from './core/layout.mjs'
import { inspectLitematic } from './core/reader.mjs'

const HELP = `
Minecraft 标语投影生成工具 (.litematic)

用法: node src/cli.mjs --text <文本> [选项]

文本与外观
  -t, --text <文本>        标语文本（\\n 可换行）
  -v, --version <版本>     目标游戏版本（默认 26.3，范围 1.20 … 26.3）
      --bg <方块>          背景材质（默认 红色混凝土）
      --fg <方块>          字体材质（默认 白色混凝土）
                           支持中文名 / 裸名 / minecraft:xxx 三种写法
      --spacing <n>        字间距（默认 1）
      --spacing-mode <m>   gap（默认）= 相邻字形墨迹之间的空格数，0 即紧贴
                           advance = 叠加在原版字体字距之上
      --border <n>         距边框距离，方块数（默认 0，字迹贴边）
      --line-gap <n>       行距，方块数（默认 1）
      --align <a>          多行对齐 left/center/right（默认 center）
      --dot-blocks <n>     每个点阵像素占几个方块（默认 1）
      --latin-dots <n>     Mojangles 每像素占几个点，1-4 或 auto（默认 auto：含汉字时 2，否则 1）
      --trim               裁掉四周全空的边

输出
  -o, --out <文件>         输出路径（默认 <名称>.litematic）
      --name <名称>        投影名 / 区域名
      --author <作者>      作者（默认 mc-slogan-wall）
      --desc <描述>        描述
      --no-air             不在材质表里保留空气
      --raw                输出未压缩 NBT（默认 gzip，符合 .litematic 规范）

查看
      --preview            终端预览（# 字体 / . 背景）
      --info               生成后回读校验并打印结构信息
      --list-versions      列出支持的版本与 data_version
      --list-blocks [词]   列出所选版本的可用方块（默认只列完整方块，可按中文/英文过滤）
      --all-blocks         配合 --list-blocks：连台阶/栅栏/植物等不完整方块一起列
      --json               以 JSON 输出摘要
  -h, --help               显示帮助
`

function parseArgs (argv) {
  const opts = { _: [] }
  const takesValue = new Set([
    '--text', '-t', '--version', '-v', '--bg', '--fg', '--spacing', '--spacing-mode',
    '--border', '--line-gap', '--align', '--dot-blocks', '--latin-dots', '--out', '-o',
    '--name', '--author', '--desc', '--list-blocks'
  ])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { opts._.push(...argv.slice(i + 1)); break }
    if (takesValue.has(a)) {
      const v = argv[i + 1]
      const nextIsOption = v === undefined || (v.startsWith('-') && !/^-\d/.test(v))
      if (nextIsOption) {
        // --list-blocks 的关键词是可选的，后面直接跟别的选项时视为无关键词
        if (a === '--list-blocks') { opts.listBlocks = ''; continue }
        throw new Error(`选项 ${a} 缺少参数`)
      }
      const key = {
        '-t': 'text', '--text': 'text',
        '-v': 'version', '--version': 'version',
        '--bg': 'bg', '--fg': 'fg',
        '--spacing': 'spacing', '--spacing-mode': 'spacingMode',
        '--border': 'border', '--line-gap': 'lineGap', '--align': 'align',
        '--dot-blocks': 'dotBlocks', '--latin-dots': 'latinDots',
        '-o': 'out', '--out': 'out', '--name': 'name',
        '--author': 'author', '--desc': 'description',
        '--list-blocks': 'listBlocks'
      }[a]
      opts[key] = v
      i++
      continue
    }
    if (a === '--preview') opts.preview = true
    else if (a === '--info') opts.info = true
    else if (a === '--json') opts.json = true
    else if (a === '--trim') opts.trim = true
    else if (a === '--no-air') opts.includeAir = false
    else if (a === '--all-blocks') opts.allBlocks = true
    else if (a === '--raw') opts.raw = true
    else if (a === '--list-versions') opts.listVersions = true
    else if (a === '--dump-grid') { opts.dumpGrid = argv[++i]; if (!opts.dumpGrid) throw new Error('--dump-grid 缺少参数') }
    else if (a === '-h' || a === '--help') opts.help = true
    else if (a.startsWith('-') && !/^-\d+$/.test(a)) throw new Error(`未知选项：${a}`)
    else opts._.push(a)
  }
  return opts
}

function toInt (v, name, { min = 0 } = {}) {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} 必须是不小于 ${min} 的整数，收到「${v}」`)
  return n
}

function main () {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`参数错误：${err.message}\n${HELP}`)
    process.exit(2)
  }

  if (opts.help || process.argv.length <= 2) {
    console.log(HELP.trim())
    return
  }

  const data = loadData()

  if (opts.listVersions) {
    console.log('支持的 Minecraft 版本（越靠后越新）：\n')
    for (const v of data.catalog.versions) {
      console.log(`  ${v.id.padEnd(9)} data_version ${String(v.dataVersion).padStart(5)}   ${v.releaseTime?.slice(0, 10) ?? ''}`)
    }
    return
  }

  if (opts.listBlocks !== undefined) {
    const version = opts.version || data.catalog.latest
    const scope = opts.allBlocks ? 'all' : 'full-cubes'
    const groups = data.catalog.groupedFor(version, { search: opts.listBlocks || '', scope })
    const total = groups.reduce((a, g) => a + g.ids.length, 0)
    const scopeLabel = scope === 'all' ? '全部方块（含台阶/栅栏/植物等不完整方块）' : '完整方块（可安全用作墙面）'
    console.log(`Minecraft ${version} · ${scopeLabel}，共 ${total} 个${opts.listBlocks ? `（匹配「${opts.listBlocks}」）` : ''}：\n`)
    for (const g of groups) {
      console.log(`  【${g.label}】${g.ids.length} 个`)
      for (let i = 0; i < g.ids.length; i += 2) {
        console.log('    ' + g.ids.slice(i, i + 2).map((n) => {
          const zh = data.catalog.zhNameOf(n)
          return (zh ? `${zh} (${n})` : n).padEnd(34)
        }).join(''))
      }
    }
    return
  }

  if (!opts.text) {
    console.error(`缺少 --text\n${HELP}`)
    process.exit(2)
  }

  const text = opts.text.replace(/\\n/g, '\n')
  let result
  try {
    result = generateSlogan({
      text,
      version: opts.version,
      bg: opts.bg,
      fg: opts.fg,
      spacing: toInt(opts.spacing, 'spacing') ?? 1,
      spacingMode: opts.spacingMode ?? 'gap',
      border: toInt(opts.border, 'border') ?? 0,
      lineGap: toInt(opts.lineGap, 'lineGap') ?? 1,
      align: opts.align ?? 'center',
      dotBlocks: toInt(opts.dotBlocks, 'dotBlocks', { min: 1 }) ?? 1,
      latinDots: opts.latinDots ?? 'auto',
      trim: opts.trim,
      name: opts.name,
      author: opts.author,
      description: opts.description,
      includeAir: opts.includeAir !== false
    })
  } catch (err) {
    console.error(`生成失败：${err.message}`)
    process.exit(1)
  }

  const outPath = resolve(opts.out || `${sanitize(result.name)}.litematic`)
  writeFileSync(outPath, opts.raw ? result.nbt : result.gzip())

  if (opts.dumpGrid) {
    // 导出期望位图，供第三方解析器（litemapy）逐格比对
    writeFileSync(resolve(opts.dumpGrid), JSON.stringify({
      width: result.layout.width,
      height: result.layout.height,
      bg: result.bg,
      fg: result.fg,
      version: result.version,
      dataVersion: result.dataVersion,
      grid: Array.from(result.layout.grid).join('')
    }))
  }

  const summary = {
    out: outPath,
    version: result.version,
    dataVersion: result.dataVersion,
    size: `${result.layout.width} x ${result.layout.height} x 1`,
    blocks: result.layout.width * result.layout.height,
    fontBlocks: result.layout.fontBlocks,
    border: result.border,
    spacing: result.spacing,
    spacingMode: result.spacingMode,
    align: result.align,
    lineGap: result.lineGap,
    dotBlocks: result.dotBlocks,
    latinDots: result.latinDots,
    hasCjk: result.hasCjk,
    palette: result.palette,
    bitsPerEntry: result.bits,
    longs: result.longCount,
    bytes: opts.raw ? result.nbt.length : result.gzip().length,
    raw: opts.raw === true,
    missingGlyphs: result.layout.missing
  }

  if (opts.preview) {
    console.log(renderAscii(result.layout, { maxWidth: Number(process.env.PREVIEW_WIDTH) || 150 }))
    console.log('')
  }

  if (opts.info) {
    const check = inspectLitematic(result.nbt, { fontBlock: result.fg })
    const problems = []
    if (check.size.x !== result.layout.width) problems.push(`宽度不符（${check.size.x} != ${result.layout.width}）`)
    if (check.size.y !== result.layout.height) problems.push(`高度不符（${check.size.y} != ${result.layout.height}）`)
    if (check.size.z !== 1) problems.push(`厚度不是 1（${check.size.z}）`)
    if (check.dataVersion !== result.dataVersion) problems.push(`data_version 不符（${check.dataVersion}）`)
    let diff = 0
    for (let i = 0; i < check.grid.length; i++) if (check.grid[i] !== result.layout.grid[i]) diff++
    if (diff) problems.push(`位图有 ${diff} 格与排版结果不一致`)
    summary.verify = problems.length === 0 ? 'ok' : problems
    summary.region = check.regionName
  }

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(`已生成：${outPath}`)
    console.log(`  版本        Minecraft ${summary.version}（data_version ${summary.dataVersion}）`)
    console.log(`  尺寸        ${summary.size}（厚 1 格）`)
    console.log(`  方块数      ${summary.blocks}（字体 ${summary.fontBlocks} / 背景 ${summary.blocks - summary.fontBlocks}）`)
    console.log(`  材质        ${summary.palette.map((p) => data.catalog.labelOf(p)).join(' , ')}`)
    console.log(`  布局        字间距 ${summary.spacing} 格（${summary.spacingMode === 'gap' ? '可见间隔' : '叠加原版字距'}）· 边框 ${summary.border} 格 · 行距 ${summary.lineGap} 格 · 对齐 ${summary.align}`)
    console.log(`  打包        ${summary.bitsPerEntry} bit/格，${summary.longs} 个 long，文件 ${summary.bytes} 字节`)
    if (summary.missingGlyphs.length) {
      console.log(`  ⚠ 缺字形    ${summary.missingGlyphs.join(' ')}（已用占位方框代替）`)
    }
    for (const w of result.warnings) console.log(`  ⚠ ${w}`)
    if (summary.verify) {
      console.log(`  回读校验    ${summary.verify === 'ok' ? '通过' : JSON.stringify(summary.verify)}`)
    }
  }
}

function sanitize (name) {
  return name.replace(/[\\/:*?"<>|\n\r\t]/g, '_').slice(0, 64) || 'slogan'
}

main()
