import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import { BLUE, RED, annotatePng, decodePng, encodePng, imageSize } from '../src/png.js'

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
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

// a PNG as other encoders write it: any color type, each row with its own filter
function pngOf({ width, height, color, pixels, filters, palette, alpha }) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color]
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length]
    raw[y * (stride + 1)] = filter
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x
      const a = x >= channels ? pixels[at - channels] : 0
      const b = y > 0 ? pixels[at - stride] : 0
      const c = x >= channels && y > 0 ? pixels[at - stride - channels] : 0
      const p = a + b - c
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
      const predicted = [0, a, b, (a + b) >>> 1, paeth][filter]
      raw[y * (stride + 1) + 1 + x] = (pixels[at] - predicted) & 0xff
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = color
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...(palette ? [chunk('PLTE', Buffer.from(palette))] : []),
    ...(alpha ? [chunk('tRNS', Buffer.from(alpha))] : []),
    // image data split in two chunks, as large images are
    chunk('IDAT', deflateSync(raw).subarray(0, 5)),
    chunk('IDAT', deflateSync(raw).subarray(5)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const ramp = (length, step = 37) => Buffer.from(Array.from({ length }, (_, i) => (i * step + 11) & 0xff))

test('an image\'s size is read from its header: PNG, JPEG and the three kinds of WebP', () => {
  assert.deepEqual(imageSize(encodePng({ width: 7, height: 5, data: Buffer.alloc(140) })), { type: 'png', width: 7, height: 5 })
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(9),
    Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]),
    Buffer.from([0xff, 0xc2, 0x00, 0x11, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03]), Buffer.alloc(9),
  ])
  assert.deepEqual(imageSize(jpeg), { type: 'jpeg', width: 1280, height: 800 })
  const riff = (kind, body) => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), Buffer.from(kind, 'latin1'), Buffer.alloc(4), body, Buffer.alloc(8)])
  const vp8x = Buffer.alloc(10)
  vp8x.writeUIntLE(1279, 4, 3)
  vp8x.writeUIntLE(799, 7, 3)
  assert.deepEqual(imageSize(riff('VP8X', vp8x)), { type: 'webp', width: 1280, height: 800 })
  const vp8l = Buffer.alloc(5)
  vp8l[0] = 0x2f
  vp8l.writeUInt32LE((1279 | (799 << 14)) >>> 0, 1)
  assert.deepEqual(imageSize(riff('VP8L', vp8l)), { type: 'webp', width: 1280, height: 800 })
  const vp8 = Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 0, 5, 0x20, 3])
  assert.deepEqual(imageSize(riff('VP8 ', vp8)), { type: 'webp', width: 1280, height: 800 })
  assert.equal(imageSize(Buffer.from('GIF89a and more bytes than enough for a header')), undefined)
})

test('PNGs of every 8-bit color type and filter decode to the same RGBA pixels', () => {
  const width = 5
  const height = 5
  const filters = [0, 1, 2, 3, 4]
  // RGBA written by our encoder, and read back
  const rgba = ramp(width * height * 4)
  assert.deepEqual(decodePng(encodePng({ width, height, data: rgba })), { width, height, data: rgba })
  assert.deepEqual(decodePng(pngOf({ width, height, color: 6, pixels: rgba, filters })).data, rgba)

  const rgb = ramp(width * height * 3)
  const fromRgb = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgb.copy(fromRgb, i * 4, i * 3, i * 3 + 3)
    fromRgb[i * 4 + 3] = 255
  }
  assert.deepEqual(decodePng(pngOf({ width, height, color: 2, pixels: rgb, filters })).data, fromRgb)

  const grey = ramp(width * height)
  const greyAlpha = ramp(width * height * 2, 53)
  assert.deepEqual([...decodePng(pngOf({ width, height, color: 0, pixels: grey, filters })).data.subarray(0, 8)], [grey[0], grey[0], grey[0], 255, grey[1], grey[1], grey[1], 255])
  assert.deepEqual([...decodePng(pngOf({ width, height, color: 4, pixels: greyAlpha, filters })).data.subarray(0, 4)], [greyAlpha[0], greyAlpha[0], greyAlpha[0], greyAlpha[1]])

  // a palette, with transparency for its first entry only
  const indexes = Buffer.from(Array.from({ length: width * height }, (_, i) => i % 3))
  const decoded = decodePng(pngOf({ width, height, color: 3, pixels: indexes, filters, palette: [10, 20, 30, 40, 50, 60, 70, 80, 90], alpha: [0] })).data
  assert.deepEqual([...decoded.subarray(0, 12)], [10, 20, 30, 0, 40, 50, 60, 255, 70, 80, 90, 255])

  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/)
  const sixteen = pngOf({ width: 1, height: 1, color: 6, pixels: Buffer.alloc(4), filters: [0] })
  sixteen[24] = 16
  assert.throws(() => decodePng(sixteen), /only 8-bit, non-interlaced PNGs/)
})

test('annotating draws a box outline outside the box and a click point, on a copy', () => {
  const image = { width: 40, height: 40, data: Buffer.alloc(40 * 40 * 4, 255) }
  const original = encodePng(image)
  const marked = decodePng(annotatePng(original, [{ box: { left: 0.1, top: 0.1, right: 0.3, bottom: 0.3 }, width: 2 }, { point: { x: 30, y: 30 }, radius: 2 }]))
  const at = (x, y) => [...marked.data.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 3)]
  // the box spans pixels 4 to 11; its outline, 2 pixels wide, lies around them
  assert.deepEqual(at(3, 3), RED)
  assert.deepEqual(at(2, 8), RED)
  assert.deepEqual(at(12, 8), RED)
  assert.deepEqual(at(4, 4), [255, 255, 255])
  // the click point: a dot, a white ring, a dark edge
  assert.deepEqual(at(30, 30), BLUE)
  assert.deepEqual(at(34, 30), [255, 255, 255])
  assert.deepEqual(at(36, 30), [15, 23, 42])
  assert.deepEqual(at(0, 39), [255, 255, 255])
  assert.deepEqual(decodePng(original).data, image.data)
})
