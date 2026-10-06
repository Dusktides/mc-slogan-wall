/**
 * 极简 ZIP 打包器（store / deflate），只用于生成发行包，无第三方依赖。
 */
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

export function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * @param {Array<{name:string, data:Buffer, compress?:boolean}>} entries
 * @returns {Buffer}
 */
export function createZip (entries) {
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8')
    const raw = entry.data
    const useDeflate = entry.compress !== false
    const body = useDeflate ? deflateRawSync(raw, { level: 9 }) : raw
    const method = useDeflate && body.length < raw.length ? 8 : 0
    const payload = method === 8 ? body : raw

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)            // version needed
    local.writeUInt16LE(0, 6)             // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)            // time
    local.writeUInt16LE(0x21, 12)         // date (1996-01-01, 固定值保证可复现)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBuf, payload)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)              // version made by
    cen.writeUInt16LE(20, 6)              // version needed
    cen.writeUInt16LE(0, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0x21, 14)
    cen.writeUInt32LE(crc32(raw), 16)
    cen.writeUInt32LE(payload.length, 20)
    cen.writeUInt32LE(raw.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt16LE(0, 30)              // extra
    cen.writeUInt16LE(0, 32)              // comment
    cen.writeUInt16LE(0, 34)              // disk
    cen.writeUInt16LE(0, 36)              // internal attrs
    cen.writeUInt32LE(0, 38)              // external attrs
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)

    offset += local.length + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuf, end])
}
