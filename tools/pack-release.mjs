/**
 * 打发行包：dist/mc-slogan-wall-<version>.zip
 *
 * 只打包源码与脚本，不含任何 Minecraft 派生的数据（data/、web/slogan-tool.html 都排除），
 * 解压后双击 start.cmd 会自动调用 tools/setup.mjs 从本机游戏生成数据。
 *
 * 用法：node tools/pack-release.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createZip } from './lib/zipwriter.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** 需要打进包里的顶层条目 */
const INCLUDE = ['src', 'tools', 'web', 'test', 'assets', 'docs', 'start.cmd', 'slogan.cmd', 'package.json', 'README.md', 'LICENSE', 'THIRD-PARTY.md', '.gitignore', '.gitattributes']

/** 排除规则（相对路径片段） */
const EXCLUDE_PARTS = ['node_modules', '.venv', 'tmp', 'dist', '.git']
const EXCLUDE_FILES = new Set(['web/slogan-tool.html', 'MC 标语墙.lnk'])

function collect (absDir, out = []) {
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name)
    const rel = relative(ROOT, abs).replace(/\\/g, '/')
    if (EXCLUDE_PARTS.some((p) => rel.split('/').includes(p))) continue
    if (EXCLUDE_FILES.has(rel)) continue
    if (name.endsWith('.litematic') || name.endsWith('.lnk')) continue
    const st = statSync(abs)
    if (st.isDirectory()) collect(abs, out)
    else if (st.isFile()) out.push({ rel, abs, size: st.size })
  }
  return out
}

const entries = []
const prefix = `mc-slogan-wall-${pkg.version}`
for (const top of INCLUDE) {
  const abs = join(ROOT, top)
  if (!existsSync(abs)) {
    console.warn(`  ! 跳过不存在的条目：${top}`)
    continue
  }
  const st = statSync(abs)
  if (st.isDirectory()) {
    for (const f of collect(abs)) entries.push({ name: `${prefix}/${f.rel}`, data: readFileSync(f.abs) })
  } else {
    entries.push({ name: `${prefix}/${top}`, data: readFileSync(abs) })
  }
}
entries.sort((a, b) => a.name.localeCompare(b.name))

const zip = createZip(entries)
mkdirSync(join(ROOT, 'dist'), { recursive: true })
const outPath = join(ROOT, 'dist', `${prefix}.zip`)
writeFileSync(outPath, zip)

const total = entries.reduce((a, e) => a + e.data.length, 0)
console.log(`已生成：${outPath}`)
console.log(`  文件 ${entries.length} 个，源码 ${(total / 1024).toFixed(0)} KB，压缩后 ${(zip.length / 1024).toFixed(0)} KB`)
console.log('  已排除：data/、web/slogan-tool.html、tmp/、.venv/、dist/')
console.log('\n解压后双击 start.cmd 即可使用（首次会自动生成数据）。')
