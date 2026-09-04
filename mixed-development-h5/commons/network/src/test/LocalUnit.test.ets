import { describe, it, expect } from '@ohos/hypium'
import { AxiosError } from '@ohos/axios'
import { executeGetWithRetry, isRetryableStatus } from '../main/ets/RequestAxios'

class TestTransportError extends Error {
  code: string = 'ETIMEDOUT'
}

export default function localUnitTest(): void {
  describe('networkResilience', () => {
    it('retriesTransientStatuses', 0, () => {
      expect(isRetryableStatus()).assertTrue()
      expect(isRetryableStatus(408)).assertTrue()
      expect(isRetryableStatus(429)).assertTrue()
      expect(isRetryableStatus(500)).assertTrue()
      expect(isRetryableStatus(503)).assertTrue()
    })

    it('doesNotRetryClientValidationErrors', 0, () => {
      expect(isRetryableStatus(400)).assertFalse()
      expect(isRetryableStatus(401)).assertFalse()
      expect(isRetryableStatus(404)).assertFalse()
    })

    it('retriesOneTransientTransportFailure', 0, async (done: Function) => {
      let attempts: number = 0
      const result: string = await executeGetWithRetry<string>(() => {
        attempts++
        if (attempts === 1) {
          return Promise.reject(new TestTransportError('timeout') as AxiosError)
        }
        return Promise.resolve('ok')
      })

      expect(result).assertEqual('ok')
      expect(attempts).assertEqual(2)
      done()
    })
  })
}
