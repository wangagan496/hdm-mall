import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf } from './native-harness.mjs'

function fixture(sizes) {
  const dimensions = [], qualities = [], released = [], maps = []
  const source = { getImageInfo: async () => ({ size: { width: 4000, height: 2000 } }),
    createPixelMap: async options => { dimensions.push(options.desiredSize); const id = maps.length; maps.push(id); return { release: async () => released.push('map-' + id) } },
    release: async () => released.push('source') }
  const packer = { packToData: async () => { const next = sizes.shift(); if (next instanceof Error) throw next; return new ArrayBuffer(next ?? 600000) }, release: async () => released.push('packer') }
  const { encodeProductFile } = execute(sourceOf('mixed-development-h5/commons/device/src/main/ets/ProductImage.ets'), { '@kit.ImageKit': { image: { createImageSource: () => source, createImagePacker: () => packer } } })
  return { encode: () => encodeProductFile(12), dimensions, released }
}
test('商品图按原比例缩放，超限时降质量并释放资源', async () => {
  const f = fixture([600000, 510000]); assert.equal((await f.encode()).byteLength, 510000)
  assert.deepEqual(JSON.parse(JSON.stringify(f.dimensions)), [{ width: 1600, height: 800 }]); assert.deepEqual(f.released, ['map-0', 'packer', 'source'])
})
test('超大图片压缩次数有界，异常也释放资源', async () => {
  const f = fixture([]); await assert.rejects(f.encode(), /图片过大/); assert.equal(f.dimensions.length, 4); assert.equal(f.released.length, 6)
  const bad = fixture([new Error('decode')]); await assert.rejects(bad.encode(), /decode/); assert.deepEqual(bad.released, ['map-0', 'packer', 'source'])
})
