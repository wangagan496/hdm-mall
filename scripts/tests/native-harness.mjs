// Execute actual ArkTS logic with platform boundaries replaced; UI/SDK behavior still needs device validation.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from '../../shoph5-vue3/node_modules/typescript/lib/typescript.js'

export const sourceOf = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
export const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
export function execute(source, dependencies = {}, globals = {}) {
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText
  const context = vm.createContext({ exports: {}, require: name => dependencies[name] ?? {},
    setTimeout, clearTimeout, console, ...globals })
  vm.runInContext(compiled, context)
  return context.exports
}
export function pageMethods(path, className, dependencies = {}, globals = {}) {
  let source = sourceOf(path)
  source = source.slice(source.indexOf('export struct ' + className))
  const end = source.indexOf('  @Builder')
  source = source.slice(0, end < 0 ? source.indexOf('  build()') : end)
  source = source.replace('export struct', 'export class').replace(/@\w+(?:\([^)]*\))?\s*/g, '') + '\n}'
  return execute(source, dependencies, globals)[className]
}
