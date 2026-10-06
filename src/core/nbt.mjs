/**
 * 最小 NBT 序列化 / 反序列化（大端序），只实现 litematic 用到的标签类型。
 * Node 与浏览器通用（只用 DataView / TextEncoder）。
 */

export const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

class Writer {
  constructor () {
    this.chunks = []
    this.length = 0
  }

  raw (bytes) {
    this.chunks.push(bytes)
    this.length += bytes.length
  }

  u8 (v) { this.raw(new Uint8Array([v & 0xff])) }
  i16 (v) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v); this.raw(b) }
  i32 (v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); this.raw(b) }
  i64 (v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v)); this.raw(b) }
  f32 (v) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v); this.raw(b) }
  f64 (v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); this.raw(b) }

  string (s) {
    const bytes = encoder.encode(s)
    this.i16(bytes.length)
    this.raw(bytes)
  }

  concat () {
    const out = new Uint8Array(this.length)
    let p = 0
    for (const c of this.chunks) { out.set(c, p); p += c.length }
    return out
  }
}

function writePayload (w, tag, value) {
  switch (tag) {
    case TAG.BYTE: w.u8(value); break
    case TAG.SHORT: w.i16(value); break
    case TAG.INT: w.i32(value); break
    case TAG.LONG: w.i64(value); break
    case TAG.FLOAT: w.f32(value); break
    case TAG.DOUBLE: w.f64(value); break
    case TAG.STRING: w.string(value); break
    case TAG.BYTE_ARRAY: {
      w.i32(value.length)
      w.raw(value instanceof Uint8Array ? value : new Uint8Array(value))
      break
    }
    case TAG.INT_ARRAY: {
      w.i32(value.length)
      for (const v of value) w.i32(v)
      break
    }
    case TAG.LONG_ARRAY: {
      w.i32(value.length)
      for (const v of value) w.i64(v)
      break
    }
    case TAG.LIST: {
      const items = value.value ?? []
      let elementType = value.type ?? TAG.END
      if (elementType === TAG.END && items.length > 0) elementType = items[0].tag
      w.u8(elementType)
      w.i32(items.length)
      for (const item of items) writePayload(w, elementType, item.value)
      break
    }
    case TAG.COMPOUND: {
      for (const [name, entry] of value) {
        w.u8(entry.tag)
        w.string(name)
        writePayload(w, entry.tag, entry.value)
      }
      w.u8(TAG.END)
      break
    }
    default: throw new Error(`不支持的 NBT 标签类型 ${tag}`)
  }
}

/** 各类型的便捷构造器 */
export const nbt = {
  byte: (v) => ({ tag: TAG.BYTE, value: v }),
  short: (v) => ({ tag: TAG.SHORT, value: v }),
  int: (v) => ({ tag: TAG.INT, value: v }),
  long: (v) => ({ tag: TAG.LONG, value: v }),
  float: (v) => ({ tag: TAG.FLOAT, value: v }),
  double: (v) => ({ tag: TAG.DOUBLE, value: v }),
  string: (v) => ({ tag: TAG.STRING, value: v }),
  byteArray: (v) => ({ tag: TAG.BYTE_ARRAY, value: v }),
  intArray: (v) => ({ tag: TAG.INT_ARRAY, value: v }),
  longArray: (v) => ({ tag: TAG.LONG_ARRAY, value: v }),
  list: (items, type) => ({ tag: TAG.LIST, value: { type, value: items } }),
  compound: (entries) => ({ tag: TAG.COMPOUND, value: entries })
}

/**
 * 序列化一个具名根复合标签
 * @param {string} name 根标签名（litematic 使用空字符串）
 * @param {Array<[string, {tag:number, value:any}]>} entries
 */
export function writeNbt (name, entries) {
  const w = new Writer()
  w.u8(TAG.COMPOUND)
  w.string(name)
  writePayload(w, TAG.COMPOUND, entries)
  return w.concat()
}

/* ------------------------------------------------------------------ */
/* 读取（用于自校验）                                                   */
/* ------------------------------------------------------------------ */
export function readNbt (bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 0
  const u8 = () => view.getUint8(pos++)
  const i16 = () => { const v = view.getInt16(pos); pos += 2; return v }
  const i32 = () => { const v = view.getInt32(pos); pos += 4; return v }
  const i64 = () => { const v = view.getBigInt64(pos); pos += 8; return v }
  const f32 = () => { const v = view.getFloat32(pos); pos += 4; return v }
  const f64 = () => { const v = view.getFloat64(pos); pos += 8; return v }
  const str = () => { const len = view.getUint16(pos); pos += 2; const s = decoder.decode(bytes.subarray(pos, pos + len)); pos += len; return s }

  const readPayload = (tag) => {
    switch (tag) {
      case TAG.BYTE: return u8() << 24 >> 24
      case TAG.SHORT: return i16()
      case TAG.INT: return i32()
      case TAG.LONG: return i64()
      case TAG.FLOAT: return f32()
      case TAG.DOUBLE: return f64()
      case TAG.STRING: return str()
      case TAG.BYTE_ARRAY: { const n = i32(); const a = bytes.subarray(pos, pos + n); pos += n; return a }
      case TAG.INT_ARRAY: { const n = i32(); const a = []; for (let i = 0; i < n; i++) a.push(i32()); return a }
      case TAG.LONG_ARRAY: { const n = i32(); const a = []; for (let i = 0; i < n; i++) a.push(i64()); return a }
      case TAG.LIST: {
        const type = u8()
        const n = i32()
        const a = []
        for (let i = 0; i < n; i++) a.push({ tag: type, value: readPayload(type) })
        return a
      }
      case TAG.COMPOUND: {
        const entries = []
        for (;;) {
          const t = u8()
          if (t === TAG.END) break
          const nm = str()
          entries.push([nm, { tag: t, value: readPayload(t) }])
        }
        return entries
      }
      default: throw new Error(`读取时遇到未知标签类型 ${tag} @${pos}`)
    }
  }

  const rootTag = u8()
  if (rootTag !== TAG.COMPOUND) throw new Error('根标签不是 Compound')
  const rootName = str()
  const root = readPayload(TAG.COMPOUND)
  if (pos !== bytes.length) throw new Error(`NBT 解析后仍有 ${bytes.length - pos} 字节残留`)
  return { name: rootName, entries: root, size: bytes.length }
}

/** 复合标签 → 普通对象（仅用于校验/展示） */
export function compoundToObject (entries) {
  const out = {}
  for (const [k, v] of entries) {
    out[k] = v.tag === TAG.COMPOUND ? compoundToObject(v.value)
      : v.tag === TAG.LIST ? v.value.map((i) => (i.tag === TAG.COMPOUND ? compoundToObject(i.value) : i.value))
        : v.value
  }
  return out
}
