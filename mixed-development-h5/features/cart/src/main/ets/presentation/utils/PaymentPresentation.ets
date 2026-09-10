const PAYMENT_RESULT_KEYS: string[] = ['result', 'success', 'isSuccess', 'payResult', 'isPay']

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
