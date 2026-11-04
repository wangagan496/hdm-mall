import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import ts from 'typescript'

const normalize = node => node?.getText().replace(/\s+/g, '') || 'void'
const signature = node => ({ parameters: node.parameters.map(p => `${p.questionToken ? '?' : ''}${normalize(p.type)}`), result: normalize(node.type) })
const nativeModelsPath = new URL('../../mixed-development-h5/commons/models/src/main/ets/BusinessModels.ets', import.meta.url)
function primitiveType(type) {
  if (!type) return undefined
  if (ts.isUnionTypeNode(type)) {
    const types = new Set(type.types.filter(item => item.kind !== ts.SyntaxKind.UndefinedKeyword).map(primitiveType))
    return types.size === 1 ? [...types][0] : undefined
  }
  if (ts.isLiteralTypeNode(type)) {
    if (ts.isStringLiteral(type.literal)) return 'string'
    if (ts.isNumericLiteral(type.literal)) return 'number'
    if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(type.literal.kind)) return 'boolean'
  }
  return { [ts.SyntaxKind.StringKeyword]: 'string', [ts.SyntaxKind.NumberKeyword]: 'number',
    [ts.SyntaxKind.BooleanKeyword]: 'boolean' }[type.kind]
}
export function checkBridge(typeSource, nativeSource, nativeModelSource = readFileSync(nativeModelsPath, 'utf8')) {
  const types = ts.createSourceFile('harmonyos.d.ts', typeSource, ts.ScriptTarget.Latest, true)
  const native = ts.createSourceFile('WebView.ts', nativeSource.slice(0, nativeSource.indexOf('@Builder')), ts.ScriptTarget.Latest, true)
  const contract = types.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'HarmonyBridge')
  const implementation = native.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'HDMWebBridge')
  if (!contract || !implementation) throw new Error('缺少 HarmonyBridge 声明或 HDMWebBridge 实现')
  const proxy = nativeSource.slice(nativeSource.indexOf('.javaScriptProxy({'))
  const exposed = new Set([...(proxy.match(/methodList:\s*\[([\s\S]*?)\]/)?.[1] || '').matchAll(/'([^']+)'/g)].map(match => match[1]))
  const errors = []
  const nativeModels = ts.createSourceFile('BusinessModels.ts', nativeModelSource, ts.ScriptTarget.Latest, true)
  // updateUser 会展开完整资料；getUser 的网页类型也必须是原生对象的有效子集。
  for (const methodName of ['updateUser', 'getUser']) {
    const method = contract.members.find(member => member.name.getText() === methodName)
    if (!method || !/\bHDMUser\b/.test(method.getText())) continue
    const webUser = types.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'HDMUser')
    const appUser = nativeModels.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'HDMUser')
    if (!webUser || !appUser) { errors.push(`${methodName}: 缺少 HDMUser 字段声明`); continue }
    for (const field of webUser.members) {
      const name = field.name.getText()
      const nativeField = appUser.members.find(member => member.name.getText() === name)
      if (!nativeField) errors.push(`${methodName}.HDMUser.${name}: 原生缺少字段`)
      else if (!primitiveType(field.type) || primitiveType(field.type) !== primitiveType(nativeField.type)) {
        errors.push(`${methodName}.HDMUser.${name}: 基本类型不一致`)
      }
    }
  }
  for (const member of contract.members) {
    const name = member.name.getText()
    const method = implementation.members.find(node => ts.isMethodDeclaration(node) && node.name.getText() === name)
    if (!method) errors.push(`${name}: 缺少原生实现`)
    else if (JSON.stringify(signature(member.type)) !== JSON.stringify(signature(method))) errors.push(`${name}: 参数或返回类型不一致`)
    if (!exposed.has(name)) errors.push(`${name}: 没有注册到本地网页桥接`)
  }
  for (const name of exposed) {
    if (!contract.members.some(member => member.name.getText() === name)) errors.push(`${name}: 缺少网页类型声明`)
  }
  if (errors.length) throw new Error(errors.join('\n'))
  return contract.members.length
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const count = checkBridge(readFileSync(join(root, 'src/types/harmonyos.d.ts'), 'utf8'),
    readFileSync(join(root, '../mixed-development-h5/features/mine/src/main/ets/presentation/views/WebView.ets'), 'utf8'))
  // 调用处的参数、方法名和返回值由同一构建入口的 vue-tsc 核对。
  console.log(`Bridge contract passed: ${count} methods; HDMUser fields checked for updateUser/getUser; call sites checked by vue-tsc`)
}
