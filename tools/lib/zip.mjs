/**
 * 极简 ZIP 读取器（只读，支持 stored / deflate）
 * 用途：直接读取 Minecraft 客户端 jar，不引入任何第三方依赖。
 */
import { inflateRawSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50

export class ZipFile {
  constructor (buffer) {
    this.buf = buffer
    const eocd = this.#findEocd()
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到 EOCD）')
    this.count = buffer.readUInt16LE(eocd + 10)
    const cdSize = buffer.readUInt32LE(eocd + 12)
    const cdOffset = buffer.readUInt32LE(eocd + 16)
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      throw new Error('不支持 ZIP64 的中央目录（Minecraft jar 通常不会触发）')
    }
    this.entries = new Map()
    let p = cdOffset
    for (let i = 0; i < this.count; i++) {
      if (buffer.readUInt32LE(p) !== CEN_SIG) throw new Error(`中央目录条目 ${i} 签名异常`)
      const method = buffer.readUInt16LE(p + 10)
      const compSize = buffer.readUInt32LE(p + 20)
      const uncompSize = buffer.readUInt32LE(p + 24)
      const nameLen = buffer.readUInt16LE(p + 28)
      const extraLen = buffer.readUInt16LE(p + 30)
      const commentLen = buffer.readUInt16LE(p + 32)
      const localOffset = buffer.readUInt32LE(p + 42)
      const name = buffer.toString('utf8', p + 46, p + 46 + nameLen)
      this.entries.set(name, { name, method, compSize, uncompSize, localOffset })
      p += 46 + nameLen + extraLen + commentLen
    }
  }

  #findEocd () {
    const buf = this.buf
    const min = Math.max(0, buf.length - 0xffff - 22)
    for (let i = buf.length - 22; i >= min; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) return i
    }
    return -1
  }

  has (name) {
    return this.entries.has(name)
  }

  list (prefix = '') {
    return [...this.entries.keys()].filter((n) => n.startsWith(prefix))
  }

  /** 读取条目原始字节 */
  read (name) {
    const entry = this.entries.get(name)
    if (!entry) throw new Error(`jar 内找不到条目：${name}`)
    const buf = this.buf
    const p = entry.localOffset
    if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`本地头签名异常：${name}`)
    const nameLen = buf.readUInt16LE(p + 26)
    const extraLen = buf.readUInt16LE(p + 28)
    const dataStart = p + 30 + nameLen + extraLen
    const raw = buf.subarray(dataStart, dataStart + entry.compSize)
    if (entry.method === 0) return Buffer.from(raw)
    if (entry.method === 8) return inflateRawSync(raw)
    throw new Error(`不支持的压缩方式 ${entry.method}：${name}`)
  }

  readText (name) {
    return this.read(name).toString('utf8')
  }
}

export function openJar (path) {
  return new ZipFile(readFileSync(path))
}
