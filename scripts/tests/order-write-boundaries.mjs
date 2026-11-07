import { execute, sourceOf } from './native-harness.mjs'

const networkSource = sourceOf('mixed-development-h5/commons/network/src/main/ets/RequestAxios.ets')
export const { BusinessError } = execute(networkSource.slice(networkSource.indexOf('export class BusinessError'), networkSource.indexOf('export function isRetryableStatus')))
export const { orderWriteFailure } = execute(sourceOf('mixed-development-h5/features/cart/src/main/ets/presentation/utils/OrderWriteFailure.ets'), { network: { BusinessError } })
