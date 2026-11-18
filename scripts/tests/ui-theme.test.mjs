import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const components = [
  'mixed-development-h5/features/cart/src/main/ets/presentation/components/QuotePanel.ets',
  'mixed-development-h5/features/mine/src/main/ets/presentation/views/ModuleBayView.ets',
]

test('报价与模块结构界面的文字和底色都使用可切换的主题资源', () => {
  for (const relative of components) {
    const source = readFileSync(resolve(root, relative), 'utf8')
    const textStarts = [...source.matchAll(/\bText\s*\(/g)].map(match => match.index)
    assert.ok(textStarts.length > 0, relative + ' 应包含界面文字')
    for (let index = 0; index < textStarts.length; index++) {
      const start = textStarts[index]
      const end = textStarts[index + 1] ?? source.length
      const chain = source.slice(start, end)
      const fontColor = chain.indexOf('.fontColor(')
      assert.notEqual(fontColor, -1, relative + ' 的每段文字都应指定颜色')
      assert.ok(chain.indexOf("$r('[ui_components].color.", fontColor) > fontColor,
        relative + ' 的每段文字都应引用明暗主题资源')
    }
    for (const match of source.matchAll(/\.backgroundColor\(([^\n]*)/g)) {
      assert.match(match[1], /\$r\('\[ui_components\]\.color\.|Color\.Transparent/,
        relative + ' 的背景应使用主题资源或透明色')
    }
    for (const match of source.matchAll(/\$r\(([^)]*)\)/g)) {
      if (match[1].includes('[ui_components]')) {
        assert.match(match[1], /^['"]\[ui_components\]\.color\.[a-z0-9_]+['"]$/,
          relative + ' 的主题资源引用必须完整')
      }
    }
    assert.doesNotMatch(source, /(?:fontColor|backgroundColor)\(\s*Color\.(?:Black|White)\s*\)/)
    assert.doesNotMatch(source, /#[0-9A-Fa-f]{6,8}/)
  }

  const quotePanel = readFileSync(resolve(root, components[0]), 'utf8')
  assert.match(quotePanel, /id\('quote-remaining'\)[\s\S]*?\.fontColor\(\$r\('\[ui_components\]\.color\.gray'\)\)/)
  const cartItem = readFileSync(resolve(root, 'mixed-development-h5/features/cart/src/main/ets/presentation/components/CartItem.ets'), 'utf8')
  assert.match(cartItem, /id\('cart-price-' \+ this\.cart\.skuId\)[\s\S]*?\.fontColor\(\$r\('\[ui_components\]\.color\.black'\)\)/)
})
