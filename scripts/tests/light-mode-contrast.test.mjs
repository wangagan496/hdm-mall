import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = path => readFileSync(new URL('../../mixed-development-h5/' + path, import.meta.url), 'utf8')
const colors = mode => Object.fromEntries(JSON.parse(source(`commons/ui-components/src/main/resources/${mode}/element/color.json`)).color.map(item => [item.name, item.value]))
function luminance(hex) {
  return hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
}
function contrast(foreground, background) {
  const levels = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
  return (levels[0] + 0.05) / (levels[1] + 0.05)
}
for (const mode of ['base', 'dark']) {
  test(`${mode}辅助文字在页面和卡片上达到4.5:1`, () => {
    const palette = colors(mode)
    for (const surface of ['white', 'under']) assert.ok(contrast(palette.gray, palette[surface]) >= 4.5, `${palette.gray}/${palette[surface]}=${contrast(palette.gray, palette[surface]).toFixed(2)}`)
  })
  test(`${mode}主操作按钮文字达到4.5:1`, () => {
    const palette = colors(mode)
    assert.ok(palette.on_primary, '主色按钮需要独立文字色，不能复用卡片表面颜色')
    assert.ok(contrast(palette.on_primary, palette.red) >= 4.5, `primary contrast=${contrast(palette.on_primary, palette.red).toFixed(2)}`)
  })
}
for (const path of ['features/category/src/main/ets/presentation/components/CategoryContent.ets', 'features/home/src/main/ets/presentation/components/HomeNewGoodsSection.ets', 'features/mine/src/main/ets/presentation/views/InventoryView.ets', 'commons/storage/src/main/ets/ConsentDialog.ets']) {
  test(`主题表面不能写死浅色：${path}`, () => {
    assert.doesNotMatch(source(path), /\.backgroundColor\((?:Color\.White|'#[A-Fa-f0-9]{6}')\)/)
  })
}
test('登录协议与注册入口使用应用主题而非系统蓝', () => {
  assert.doesNotMatch(source('features/mine/src/main/ets/presentation/views/LoginView.ets'), /#007DFB/i)
})
test('我的页面渐变不能在深色文字主题下保留固定浅色底', () => {
  assert.doesNotMatch(source('features/mine/src/main/ets/presentation/views/MineView.ets'), /colors:\s*\[\['#FFF1E5'/)
})
test('首页搜索框不在半透明浅底上使用白字，跟随系统主题', () => {
  const page = source('features/home/src/main/ets/presentation/views/HomeView.ets')
  const header = page.slice(page.indexOf('  HomeHeader()'), page.indexOf('  HomeHeader()') + 1300)
  assert.match(header, /Text\('搜索\.\.\.'\)[\s\S]*?fontColor\(\$r\('\[ui_components\]\.color\.text'\)\)/)
  assert.match(header, /backgroundColor\(\$r\('\[ui_components\]\.color\.white'\)\)/)
  assert.doesNotMatch(header, /#33191919/)
})
test('应用继续跟随系统深浅色而非强制主题', () => {
  const ability = source('products/phone/src/main/ets/phoneability/PhoneAbility.ets')
  assert.match(ability, /setColorMode\(ConfigurationConstant\.ColorMode\.COLOR_MODE_NOT_SET\)/)
  assert.doesNotMatch(ability, /setColorMode\([^)]*COLOR_MODE_(?:LIGHT|DARK)\)/)
})
for (const mode of ['base', 'dark']) {
  test(`${mode}首次同意弹层正文与操作都有足够对比度`, () => {
    const palette = Object.fromEntries(JSON.parse(source(`commons/storage/src/main/resources/${mode}/element/color.json`)).color.map(item => [item.name, item.value]))
    for (const foreground of ['consent_text', 'consent_action']) assert.ok(contrast(palette[foreground], palette.consent_surface) >= 4.5)
  })
}
