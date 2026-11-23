import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyPromiseCandidates } from '../src/promises/verify.ts'

const chart = '尺码表：M码 胸围96厘米\nL码 胸围100厘米'
function check(category:string, fieldId:string, quote:string, value:string, description=quote) {
  const candidate = { fieldId, source:'description', quote, value, condition:null, unit:null }
  return verifyPromiseCandidates(JSON.stringify({claims:[candidate]}), {category, revision:2, name:'商品', description}).entries.find(e=>e.fieldId===fieldId)!
}

test('尺码表在服饰和鞋靴逐字保留多行，箱包不适用，尺寸数值不可修改', () => {
  for(const category of ['服饰','鞋靴']) {
    const entry=check(category,'size-chart',chart,chart)
    assert.equal(entry.status,'known')
    assert.equal(entry.quote,chart)
    assert.equal(entry.suggestedAfterSaleKind,undefined)
    assert.equal(check(category,'size-chart',chart,chart.replace('100','101')).status,'unknown')
    assert.equal(check(category,'size-chart','尺码以实际为准','尺码以实际为准').status,'unknown')
  }
  const table='尺码表：\n尺码 胸围(cm) 衣长(cm)\nM 96 60\nL 100 62'
  assert.equal(check('服饰','size-chart',table,table).value,table)
  const noDimension='尺码表：\n尺码 胸围(cm) 衣长(cm)\nM 96\nL 100 62'
  assert.equal(check('服饰','size-chart',noDimension,noDimension).status,'unknown')
  for(const [field,raw,value] of [['size-chart',chart,chart],['fit','版型偏小','偏小']]) {
    assert.equal(check('箱包',field!,raw!,value!).status,'not-applicable')
  }
})

test('版型保留字面值和建议，拒收否定、猜测、无关描述和缺失来源',()=>{
  const quote='版型偏大，建议选小一码'
  const entry=check('服饰','fit',quote,'偏大')
  assert.equal(entry.fit,'偏大')
  assert.equal(entry.condition,'建议选小一码')
  assert.equal(entry.suggestedAfterSaleKind,undefined)
  assert.equal(check('鞋靴','fit','正常尺码','正常尺码').fit,'标准')
  for(const [raw,value] of [['版型不偏大','偏大'],['不是偏小码','偏小'],['版型宽松','宽松'],['鞋盒尺寸偏大','偏大'],['可能版型偏小','偏小'],['口袋整体偏大','偏大'],['据说版型偏小','偏小'],['版型偏大？','偏大']]) {
    assert.equal(check('服饰','fit',raw!,value!).status,'unknown',raw)
  }
  assert.equal(check('服饰','fit','版型偏大','偏大','版型偏大？').status,'unknown')
  assert.equal(check('服饰','fit','除童装外，版型偏大','偏大').conditionNeedsReview,true)
  assert.equal(check('鞋靴','fit',quote,'偏大','没有版型说明').status,'unknown')
})
