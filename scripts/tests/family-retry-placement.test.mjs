import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets', import.meta.url), 'utf8')

test('亲友中心每处加载失败提示旁边都有重试按钮，用户不用滚过整页列表去找', () => {
  const errors = [...source.matchAll(/Text\(this\.errorText\)/g)]
  assert.ok(errors.length > 0)
  for (const match of errors) {
    const after = source.slice(match.index, match.index + 600)
    assert.match(after, /Button\('重试加载'\)/, '失败提示后 600 字符内必须出现重试按钮：' + source.slice(0, match.index).split('\n').length + ' 行')
  }
})
