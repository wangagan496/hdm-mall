import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')

test('设备回归只比较本设备的端口映射，其他模拟器的项目改映射不应判本轮清理失败', () => {
  for (const path of ['scripts/device-trade-regression.ps1', 'scripts/device-trade-network-probe.ps1']) {
    const lines = read(path).split(/\r?\n/)
    for (const name of ['Existing', 'After']) {
      const line = lines.find(text => text.includes('$' + name + ' = @(') && text.includes('fport ls'))
      assert.ok(line, path + ' 缺少 $' + name + ' 端口快照')
      assert.match(line, /Where-Object .*\$Target/, path + ' 的 $' + name + ' 必须只保留 $Target 的映射')
    }
  }
})
