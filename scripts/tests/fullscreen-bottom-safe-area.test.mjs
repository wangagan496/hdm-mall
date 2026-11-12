import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../../mixed-development-h5/', import.meta.url)
function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['oh_modules', 'node_modules', 'build', '.hvigor'].includes(entry.name)) return []
    const target = join(directory, entry.name)
    return entry.isDirectory() ? collect(target) : target.endsWith('.ets') ? [target] : []
  })
}
function isFullscreenActionPage(source) {
  return /\b(?:Scroll|List|Grid)\s*\(/.test(source) && /\b(?:Button|onClick)\s*\(/.test(source) &&
    (/\bNavDestination\s*\(/.test(source) || /@Entry\b/.test(source)) &&
    !/\.mode\(NavDestinationMode\.DIALOG\)/.test(source)
}
function hasBottomProtection(source) {
  const binding = source.match(/@Storage(?:Prop|Link)\s*\(GlobalVariable\.SAFE_AREA_BOTTOM\)\s*(\w+)\s*:/)
  if (!binding) return false
  return new RegExp('(?:bottom\\s*:[^,}]*this\\.' + binding[1] + '\\b|\\.padding\\(\\s*this\\.' + binding[1] + '\\s*\\))').test(source)
}
const pages = collect(fileURLToPath(root)).map(file => ({ file, source: readFileSync(file, 'utf8') }))
  .filter(({ source }) => isFullscreenActionPage(source))

test('扫描不把嵌入组件和对话页当作全屏页', () => {
  assert.equal(isFullscreenActionPage('import { NavDestinationContext } from kit; @Component struct Tile { build() { Scroll() { Button("提交") } } }'), false)
  assert.equal(isFullscreenActionPage('NavDestination() { Scroll() { Button("提交") } }.mode(NavDestinationMode.DIALOG)'), false)
})
test('固定操作栏已保护底部时不要求外层重复留白', () => {
  const source = '@StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0; NavDestination() { Column() { Scroll() { Text("内容") }.layoutWeight(1); Row() { Button("提交") }.padding({ bottom: 12 + this.safeBottom }) } }'
  assert.equal(isFullscreenActionPage(source), true)
  assert.equal(hasBottomProtection(source), true)
  assert.equal(hasBottomProtection(source.replace('bottom: 12', 'top: 12')), false)
})
test('内嵌购物车复用首页底栏安全区，独立购物车单独保护', () => {
  const cart = readFileSync(new URL('features/cart/src/main/ets/presentation/views/CartView.ets', root), 'utf8')
  const index = readFileSync(new URL('products/phone/src/main/ets/pages/Index.ets', root), 'utf8')
  assert.match(cart, /bottom:\s*this\.standalone\s*\?\s*this\.safeBottom\s*:\s*0/)
  assert.match(index, /CartView\(\{ standalone: false \}\)/)
  assert.match(index, /\.padding\(\{ bottom: this\.bottomHeight \}\)/)
})
test('分页和提交全屏滚动页不能漏检，单纯声明底部变量不足以通过', () => {
  for (const container of ['Scroll', 'List', 'Grid']) {
    const source = `@StorageProp(GlobalVariable.SAFE_AREA_BOTTOM) safeBottom: number = 0; NavDestination() { ${container}() { Button('下一页').onClick(() => {}) } }`
    assert.equal(isFullscreenActionPage(source), true)
    assert.equal(hasBottomProtection(source), false)
  }
})

test('全屏滚动操作页扫描包含亲友中心及既有安全区参考页', () => {
  for (const name of ['FamilyView.ets', 'AfterSaleApplyView.ets', 'AuditLogView.ets']) assert.ok(pages.some(({ file }) => file.endsWith(name)), name)
})
for (const { file, source } of pages) {
  test('全屏滚动操作页底部安全区：' + relative(process.cwd(), file), () => {
    assert.ok(hasBottomProtection(source), '必须将 SAFE_AREA_BOTTOM 用于页面或固定操作栏底部，不能让末尾按钮压住手势条')
  })
}
test('分页用户可点击阈值保持 2780，不得为探针放宽', () => {
  const source = readFileSync(new URL('../device-trade-regression.ps1', import.meta.url), 'utf8')
  assert.match(source, /\$Box\[3\] -lt 2780/)
})
