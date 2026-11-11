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
  const context = vm.createContext({ exports: {}, require: name => {
    if (name === './ReturnPolicy' || name === 'models') {
      return { ...execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/ReturnPolicy.ets')), ...dependencies[name] }
    }
    return dependencies[name] ?? {}
  },
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
  // Background recovery timers must not hold the test process open; tests of recovery
  // inject a controllable timer and execute the same production scheduler.
  const recovery = execute(sourceOf('mixed-development-h5/commons/storage/src/main/ets/RecoveryQuery.ets'), {}, {
    setTimeout: globals.setTimeout ?? ((fn, delay) => { const timer = setTimeout(fn, delay); timer.unref(); return timer }),
    clearTimeout: globals.clearTimeout ?? clearTimeout,
  })
  const policy = execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/ReturnPolicy.ets'))
  const afterSales = execute(sourceOf('mixed-development-h5/commons/models/src/main/ets/AfterSaleModels.ets'))
  return execute(source, dependencies, { ...recovery, ...policy, ...afterSales,
    Scroller: class { scrollToIndex() {} }, ScrollAlign: { END: 'end' }, ...globals })[className]
}
