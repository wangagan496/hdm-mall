import { execute, sourceOf } from './native-harness.mjs'

// 保留实际表单转换和全部业务方法，仅剔除 ArkUI 构建块及装饰器。
export function addressPage(globals = {}) {
  const source = sourceOf('mixed-development-h5/features/mine/src/main/ets/presentation/views/AddressView.ets')
  const helpers = source.slice(source.indexOf('const EMPTY_FORM'), source.indexOf('@Builder'))
  let methods = source.slice(source.indexOf('export struct AddressView'), source.indexOf('  @Builder\n  private AddressCard'))
  const builderStart = methods.indexOf('  @Builder\n  DeleteConfirmBuilder')
  const builderEnd = methods.indexOf('  aboutToAppear')
  if (builderStart >= 0) methods = methods.slice(0, builderStart) + methods.slice(builderEnd)
  methods = methods.replace('export struct', 'export class').replace(/@\w+(?:\([^)]*\))?\s*/g, '')
  return execute(helpers + '\n' + methods + '\n}', {}, globals).AddressView
}
