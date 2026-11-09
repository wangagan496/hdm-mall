import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceOf } from './native-harness.mjs'
const root = 'mixed-development-h5/features/'
for (const path of ['mine/FamilyView','cart/PayView','cart/PayResultView','cart/OrderView','cart/EvaluationView','mine/AddressView','mine/HistoryView','home/SearchResultView']) {
  test(`UX返修 ${path} 可操作按钮均明确主题背景与文字`, () => {
    const [feature, view] = path.split('/')
    const source = sourceOf(`${root}${feature}/src/main/ets/presentation/views/${view}.ets`)
    const buttons = source.split(/\bButton\(/).slice(1)
    for (const button of buttons) {
      const style = button.split('.onClick(')[0]
      assert.match(style, /\.backgroundColor\(/, button.slice(0, 100))
      assert.match(style, /\.fontColor\(/, button.slice(0, 100))
    }
  })
}
test('UX返修 亲友筛选分两列且错误态可重试，分类返回使用主色描边', () => {
  const family = sourceOf(`${root}mine/src/main/ets/presentation/views/FamilyView.ets`)
  assert.match(family, /Flex\(\{ wrap: FlexWrap\.Wrap/)
  assert.match(family, /\.width\('48%'\)/)
  assert.match(family, /Button\('重试加载'\)/)
  const search = sourceOf(`${root}home/src/main/ets/presentation/views/SearchResultView.ets`)
  assert.match(search, /Button\(this\.backLabel\(\)\)[\s\S]*?\.border\(\{ width: 1, color: \$r\('\[ui_components\]\.color\.red'\)/)
})
