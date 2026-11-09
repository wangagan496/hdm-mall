import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, sourceOf } from './native-harness.mjs'

const api = execute(sourceOf('mixed-development-h5/features/home/src/main/ets/data/api/goodsPresentation.ets'), {
  isFallbackSkuId: id => id.startsWith('fallback')
})

test('详情商品展示转换保留下架和可购买状态', () => {
  const source = { id: 'p1', name: '商品', desc: '', price: 20, picture: '', orderNum: 0 }
  for (const detail of [
    { id: 'p1', status: 'on', available: true, inventory: 2, skus: [{ id: 's1', inventory: 2, specs: [] }], specs: [] },
    { id: 'p1', status: 'off', available: false, inventory: 2, skus: [{ id: 's1', inventory: 2, specs: [] }], specs: [] }
  ]) {
    const result = api.normalizeGoodsPresentation(source, detail)
    assert.equal(result.status, detail.status)
    assert.equal(result.available, detail.available)
  }
})
