/**
 * Images without dependencies: the size of a PNG, JPEG or WebP from its header, and a copy of a PNG with boxes and
 * points drawn on it, decoded and encoded with Node's zlib.
 */
import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
export const RED = [229, 72, 77]
export const BLUE = [48, 162, 255]

/** An image's size in pixels from its header, or undefined for a file that is not a PNG, JPEG or WebP. */
export function imageSize(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(SIGNATURE) && buffer.toString('latin1', 12, 16) === 'IHDR') {
    return { type: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let at = 2
    while (at + 9 <= buffer.length) {
      if (buffer[at] !== 0xff) return undefined
      const marker = buffer[at + 1]
      if (marker === 0xff) {
        at++
        continue
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        at += 2
        continue
      }
      // a start of frame (not DHT, JPG or DAC) carries the size
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpeg', width: buffer.readUInt16BE(at + 7), height: buffer.readUInt16BE(at + 5) }
      }
      at += 2 + buffer.readUInt16BE(at + 2)
    }
    return undefined
  }
  if (buffer.length >= 30 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('latin1', 12, 16)
    if (chunk === 'VP8X') return { type: 'webp', width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21)
      return { type: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
    }
    if (chunk === 'VP8 ') return { type: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
  }
  return undefined
}

/** An 8-bit, non-interlaced PNG (grey, RGB, palette, with or without alpha) as RGBA pixels. */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')
  let header
  let palette
  let alpha
  const data = []
  for (let at = 8; at + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('latin1', at + 4, at + 8)
    const body = buffer.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] }
    else if (type === 'PLTE') palette = body
    else if (type === 'tRNS') alpha = body
    else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
    at += 12 + length
  }
  if (!header) throw new Error('a PNG without a header')
  const { width, height, depth, color, interlace } = header
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color]
  if (depth !== 8 || !channels || interlace !== 0 || (color === 3 && !palette)) {
    throw new Error(`only 8-bit, non-interlaced PNGs are drawn on (this one is ${depth}-bit, color type ${color}${interlace ? ', interlaced' : ''})`)
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  if (raw.length < (stride + 1) * height) throw new Error('a PNG whose image data is cut short')
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = y * (stride + 1) + 1
    const row = y * stride
    const up = row - stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[row + x - channels] : 0
      const b = y > 0 ? pixels[up + x] : 0
      const c = x >= channels && y > 0 ? pixels[up + x - channels] : 0
      let value = raw[line + x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >>> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) throw new Error(`a PNG with an unknown filter (${filter})`)
      pixels[row + x] = value & 0xff
    }
  }
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    if (color === 6) pixels.copy(rgba, o, o, o + 4)
    else if (color === 2) {
      rgba[o] = pixels[i * 3]
      rgba[o + 1] = pixels[i * 3 + 1]
      rgba[o + 2] = pixels[i * 3 + 2]
      rgba[o + 3] = 255
    } else if (color === 0 || color === 4) {
      const grey = pixels[i * channels]
      rgba[o] = grey
      rgba[o + 1] = grey
      rgba[o + 2] = grey
      rgba[o + 3] = color === 4 ? pixels[i * 2 + 1] : 255
    } else {
      const index = pixels[i]
      rgba[o] = palette[index * 3] ?? 0
      rgba[o + 1] = palette[index * 3 + 1] ?? 0
      rgba[o + 2] = palette[index * 3 + 2] ?? 0
      rgba[o + 3] = alpha && index < alpha.length ? alpha[index] : 255
    }
  }
  return { width, height, data: rgba }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'latin1')
  body.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}

/** RGBA pixels as a PNG; each row is filtered with Sub, which suits screenshots. */
export function encodePng({ width, height, data }) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const line = y * (stride + 1)
    raw[line] = 1
    for (let x = 0; x < stride; x++) raw[line + 1 + x] = (data[y * stride + x] - (x >= 4 ? data[y * stride + x - 4] : 0)) & 0xff
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function paint(image, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
  const o = (y * image.width + x) * 4
  image.data[o] = r
  image.data[o + 1] = g
  image.data[o + 2] = b
  image.data[o + 3] = 255
}

/** A box outline drawn just outside `box` (fractions of the image), so that what it marks stays visible. */
export function drawBox(image, box, { color = RED, width = 4 } = {}) {
  const left = Math.round(box.left * image.width)
  const right = Math.round(box.right * image.width) - 1
  const top = Math.round(box.top * image.height)
  const bottom = Math.round(box.bottom * image.height) - 1
  for (let t = 1; t <= width; t++) {
    for (let x = left - t; x <= right + t; x++) {
      paint(image, x, top - t, color)
      paint(image, x, bottom + t, color)
    }
    for (let y = top - t; y <= bottom + t; y++) {
      paint(image, left - t, y, color)
      paint(image, right + t, y, color)
    }
  }
}

/** A dot in a white ring with a dark edge at a pixel, where a click would land: visible on any background. */
export function drawPoint(image, cx, cy, { color = BLUE, radius = 9 } = {}) {
  const outer = radius + 5
  for (let y = -outer; y <= outer; y++) {
    for (let x = -outer; x <= outer; x++) {
      const d = Math.hypot(x, y)
      if (d <= radius) paint(image, cx + x, cy + y, color)
      else if (d <= radius + 3) paint(image, cx + x, cy + y, [255, 255, 255])
      else if (d <= outer) paint(image, cx + x, cy + y, [15, 23, 42])
    }
  }
}

/**
 * A PNG with marks drawn on a copy: `{box}` outlines a box (fractions of the image), `{point: {x, y}}` dots a pixel.
 * @returns {Buffer}
 */
export function annotatePng(buffer, marks) {
  const image = decodePng(buffer)
  for (const mark of marks) {
    if (mark.box) drawBox(image, mark.box, mark)
    if (mark.point) drawPoint(image, Math.round(mark.point.x), Math.round(mark.point.y), mark)
  }
  return encodePng(image)
}
