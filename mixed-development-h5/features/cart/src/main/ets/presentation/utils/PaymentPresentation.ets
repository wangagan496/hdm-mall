import { GlobalVariable } from 'constants'

const PAYMENT_RESULT_KEYS: string[] = ['result', 'success', 'isSuccess', 'payResult', 'isPay']
const DEMO_ORDER_PREFIX: string = 'demo-alipay-'
let demoOrderSequence: number = 0

/** Reads the Debug-only switch initialized by PhoneAbility. */
export function isPaymentDemoMode(): boolean {
  return AppStorage.get<boolean>(GlobalVariable.PAYMENT_DEMO_MODE) === true
}

/** Returns true only for locally generated demo orders. */
export function isDemoPaymentOrder(orderId: string): boolean {
  return orderId.startsWith(DEMO_ORDER_PREFIX)
}

/** Creates a non-server order id used only by the Debug payment demo. */
export function createDemoPaymentOrderId(): string {
  demoOrderSequence += 1
  return DEMO_ORDER_PREFIX + new Date().getTime().toString() + '-' + demoOrderSequence.toString()
}

/**
 * Parses the payment callback without trusting arbitrary query values.
 * Undefined means that the callback is malformed or does not contain a boolean result.
 */
export function parsePaymentResultValue(url: string): boolean | undefined {
  const queryIndex: number = url.indexOf('?')
  if (queryIndex < 0) {
    return undefined
  }

  const params: string[] = url.substring(queryIndex + 1).split('&')
  let fallbackValue: string = ''
  let resultValue: string = ''
  for (const item of params) {
    const separatorIndex: number = item.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }
    const key: string = item.substring(0, separatorIndex)
    const rawValue: string = item.substring(separatorIndex + 1)
    if (!rawValue) {
      continue
    }

    let decodedValue: string = ''
    try {
      decodedValue = decodeURIComponent(rawValue.replace(/\+/g, ' '))
    } catch {
      continue
    }
    if (!decodedValue) {
      continue
    }
    if (!fallbackValue) {
      fallbackValue = decodedValue
    }
    if (PAYMENT_RESULT_KEYS.includes(key)) {
      resultValue = decodedValue
      break
    }
  }

  const value: string = resultValue || fallbackValue
  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  return undefined
}
