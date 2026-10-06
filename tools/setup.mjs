/**
 * 一键初始化：检查并生成全部运行所需数据。
 *
 * 幂等 —— 已存在的数据文件会跳过，只补缺的。
 *
 *   node tools/setup.mjs            # 缺什么补什么
 *   node tools/setup.mjs --force    # 全部重建
 *   node tools/setup.mjs --check    # 只检查，不生成
 *
 * 需要：本机装过 Minecraft（用于提取原版字形/中文名/模型），以及联网（方块目录与 Unifont）。
 */
import { existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const argv = process.argv.slice(2)
const FORCE = argv.includes('--force')
const CHECK_ONLY = argv.includes('--check')

const MC_DIR = process.env.MC_DIR || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), '.minecraft')

/** 每一项：产出文件 + 生成脚本 + 依赖（用于决定先跑哪个）+ 失败时的影响 */
const STEPS = [
  {
    name: '版本化方块目录',
    out: ['data/blocks-by-version.json'],
    script: 'tools/build-blocks-data.mjs',
    needs: ['网络'],
    why: '提供 1.20–26.3 各版本的方块清单与 data_version'
  },
  {
    name: 'Mojangles 原版字形',
    out: ['data/glyphs/mojangles.json'],
    script: 'tools/extract-mojangles.mjs',
    needs: ['本机 Minecraft'],
    why: '拉丁字母/数字/标点的逐像素字形与字宽'
  },
  {
    name: 'Unifont 汉字点阵',
    out: ['data/glyphs/unifont.bin.gz', 'data/glyphs/unifont.json'],
    script: 'tools/extract-unifont.mjs',
    needs: ['网络'],
    why: '汉字的 16×16 点阵'
  },
  {
    name: '方块中文名',
    out: ['data/block-names-zh.json'],
    script: 'tools/build-block-names.mjs',
    needs: ['本机 Minecraft（需启动过一次，资源库已下载语言文件）'],
    why: '选择器与命令行里的中文方块名'
  },
  {
    name: '完整方块判定',
    out: ['data/block-shapes.json'],
    script: 'tools/build-block-shapes.mjs',
    needs: ['本机 Minecraft'],
    why: '过滤掉台阶/栅栏/植物等不完整方块'
  },
  {
    name: '方块预览颜色',
    out: ['data/block-colors.json'],
    script: 'tools/build-block-colors.mjs',
    needs: ['本机 Minecraft'],
    why: '网页预览里的方块配色'
  }
]

const FINAL_STEP = {
  name: '单文件网页预览',
  out: ['web/slogan-tool.html'],
  script: 'tools/build-preview.mjs',
  needs: ['以上全部'],
  why: 'web/slogan-tool.html'
}

function satisfied (step) {
  return step.out.every((p) => existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).size > 0)
}

function human (n) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`
}

function run (script) {
  const res = spawnSync(process.execPath, [join(ROOT, script)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, MC_DIR }
  })
  return res.status === 0
}

console.log('Minecraft 标语墙投影生成器 · 数据初始化')
console.log('='.repeat(64))
console.log(`项目目录 : ${ROOT}`)
console.log(`Minecraft: ${MC_DIR}${existsSync(MC_DIR) ? '' : '   ← 不存在'}`)
console.log(`模式     : ${CHECK_ONLY ? '仅检查' : FORCE ? '强制重建' : '补缺'}`)
console.log('')

const mcExists = existsSync(MC_DIR)
const todo = []
for (const step of STEPS) {
  const ok = satisfied(step) && !FORCE
  const needsMc = step.needs.some((n) => n.startsWith('本机 Minecraft'))
  const blocked = needsMc && !mcExists
  console.log(`${ok ? '✓' : blocked ? '✗' : '·'} ${step.name.padEnd(16)} ${step.why}`)
  if (!ok) {
    console.log(`    ${blocked ? '缺少 Minecraft 安装目录' : '待生成'}  （需要：${step.needs.join('、')}）`)
    if (!blocked) todo.push(step)
  }
}

if (CHECK_ONLY) {
  console.log('')
  console.log(todo.length === 0 ? '全部数据已就绪。' : `还需生成 ${todo.length} 项，运行 node tools/setup.mjs 即可。`)
  process.exit(0)
}

let failed = []
if (todo.length === 0) {
  console.log('\n数据已齐全，无需生成。')
} else {
  console.log(`\n开始生成 ${todo.length} 项…\n`)
  for (let i = 0; i < todo.length; i++) {
    const step = todo[i]
    console.log(`\n${'─'.repeat(64)}`)
    console.log(`[${i + 1}/${todo.length}] ${step.name}  →  ${step.script}`)
    console.log('─'.repeat(64))
    if (!run(step.script)) failed.push(step)
  }
}

/* 最后一步：打包网页预览 */
const needPreview = FORCE || !satisfied(FINAL_STEP)
if (needPreview && failed.length === 0) {
  console.log(`\n${'─'.repeat(64)}`)
  console.log(`[最后] ${FINAL_STEP.name}  →  ${FINAL_STEP.script}`)
  console.log('─'.repeat(64))
  if (!run(FINAL_STEP.script)) failed.push(FINAL_STEP)
}

console.log(`\n${'='.repeat(64)}`)
if (failed.length === 0) {
  const total = STEPS.concat([FINAL_STEP])
    .flatMap((s) => s.out)
    .filter((p) => existsSync(join(ROOT, p)))
    .reduce((a, p) => a + statSync(join(ROOT, p)).size, 0)
  console.log(`✅ 初始化完成，数据合计 ${human(total)}`)
  console.log('')
  console.log('下一步：')
  console.log('  · 双击 start.cmd          打开网页版（可视化调参 + 直接下载投影）')
  console.log('  · node src/cli.mjs --help 使用命令行')
  console.log('  · npm test                跑自动化测试（可选，需第三方校验环境）')
} else {
  console.log(`❌ 有 ${failed.length} 项失败：`)
  for (const s of failed) console.log(`   - ${s.name}（${s.script}）`)
  console.log('')
  console.log('常见原因：')
  console.log('  · 没有安装/启动过 Minecraft → 先启动一次正版客户端以下载资源')
  console.log('  · 网络不通 → 方块目录与 Unifont 需要联网下载')
  console.log('  · 游戏装在别处 → 设置环境变量 MC_DIR 指向 .minecraft 目录后重试')
  process.exit(1)
}
