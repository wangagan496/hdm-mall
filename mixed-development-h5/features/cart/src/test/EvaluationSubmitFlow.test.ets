import { describe, expect, it } from '@ohos/hypium'
import { EvaluationSubmitActions, submitEvaluationFlow } from '../main/ets/presentation/utils/EvaluationSubmitFlow'

class TestEvaluationActions implements EvaluationSubmitActions {
  events: string[] = []
  active: boolean = true
  failRemote: boolean = false
  leaveWhileSubmitting: boolean = false

  submitRemote(): Promise<void> {
    this.events.push('remote')
    if (this.leaveWhileSubmitting) {
      this.active = false
    }
    return this.failRemote ? Promise.reject(new Error('remote failed')) : Promise.resolve()
  }

  isActive(): boolean {
    return this.active
  }

  returnToOrderList(): void {
    this.events.push('back')
    this.active = false
  }
}

export default function evaluationSubmitFlowTest(): void {
  describe('evaluationSubmitFlow', () => {
    it('returnsOnlyAfterServerConfirmsSave', 0, async (done: Function) => {
      const actions = new TestEvaluationActions()
      await submitEvaluationFlow(actions)
      expect(actions.events.join(',')).assertEqual('remote,back')
      done()
    })

    it('remoteFailureKeepsPageAndAllowsRetry', 0, async (done: Function) => {
      const actions = new TestEvaluationActions()
      actions.failRemote = true
      let failed: boolean = false
      try {
        await submitEvaluationFlow(actions)
      } catch {
        failed = true
      }
      expect(failed).assertTrue()
      expect(actions.events.join(',')).assertEqual('remote')
      actions.failRemote = false
      await submitEvaluationFlow(actions)
      expect(actions.events.join(',')).assertEqual('remote,remote,back')
      done()
    })

    it('doesNothingAfterPageHasLeft', 0, async (done: Function) => {
      const actions = new TestEvaluationActions()
      actions.active = false
      await submitEvaluationFlow(actions)
      expect(actions.events.length).assertEqual(0)
      done()
    })

    it('lateResponseDoesNotPopAnotherPage', 0, async (done: Function) => {
      const actions = new TestEvaluationActions()
      actions.leaveWhileSubmitting = true
      await submitEvaluationFlow(actions)
      expect(actions.events.join(',')).assertEqual('remote')
      done()
    })
  })
}
