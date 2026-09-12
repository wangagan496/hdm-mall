import { describe, it, expect } from '@ohos/hypium'
import { AxiosError } from '@ohos/axios'
import { BusinessError, executeGetWithRetry, isRetryableStatus } from '../main/ets/RequestAxios'

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

    it('carriesHttpStatusOnBusinessErrors', 0, () => {
      // 业务失败需要带回 HTTP 状态码，否则调用方无法区分"接口不存在"和"业务拒绝"。
      expect(new BusinessError('订单已发货', 405).httpStatus).assertEqual(405)
      expect(new BusinessError('参数错误', 400).httpStatus).assertEqual(400)
      expect(new BusinessError('订单已发货', 405).message).assertEqual('订单已发货')
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

    it('keepsBusinessErrorThroughGetRetry', 0, async (done: Function) => {
      // 业务失败不是传输层错误：不能重试，也不能被包成普通 Error 而丢掉 httpStatus。
      let attempts: number = 0
      let caught: Error | null = null
      try {
        await executeGetWithRetry<string>(() => {
          attempts++
          return Promise.reject(new BusinessError('订单已发货', 405))
        })
      } catch (error) {
        caught = error as Error
      }

      expect(caught instanceof BusinessError).assertTrue()
      expect((caught as BusinessError).httpStatus).assertEqual(405)
      expect(attempts).assertEqual(1)
      done()
    })
  })
}
