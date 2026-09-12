import { describe, expect, it } from '@ohos/hypium'
import { EvaluationSubmitActions, submitEvaluationFlow } from '../main/ets/presentation/utils/EvaluationSubmitFlow'

class TestEvaluationActions implements EvaluationSubmitActions {
  events: string[] = []
  active: boolean = true
  failRemote: boolean = false
  failLocal: boolean = false
  leaveWhileSaving: boolean = false

  submitRemote(): Promise<void> {
    this.events.push('remote')
    return this.failRemote ? Promise.reject(new Error('remote failed')) : Promise.resolve()
  }

  saveLocal(): Promise<void> {
    this.events.push('save')
    if (this.leaveWhileSaving) {
      this.active = false
    }
    return this.failLocal ? Promise.reject(new Error('local failed')) : Promise.resolve()
  }

  isActive(): boolean {
    return this.active
  }

  returnToPrevious(): void {
    this.events.push('back')
    this.active = false
  }
}

export default function evaluationSubmitFlowTest(): void {
  describe('evaluationSubmitFlow', () => {
    it('demoSavesAndReturnsWithoutRemoteRequest', 0, async (done: Function) => {
      const actions = new TestEvaluationActions()
      actions.failRemote = true
      await submitEvaluationFlow(true, actions)
      expect(actions.events.join(',')).assertEqual('save,back')
      done()
    })

    it('saveFailureDoesNotNavigateAndAllowsRetry', 0, async (done: Function) => {
      const actions = new TestEvaluationActions()
      actions.failLocal = true
      let failed: boolean = false
      try {
        await submitEvaluationFlow(true, actions)
      } catch {
        failed = true
      }
      expect(failed).assertTrue()
      expect(actions.events.join(',')).assertEqual('save')
      actions.failLocal = false
      await submitEvaluationFlow(true, actions)
      expect(actions.events.join(',')).assertEqual('save,save,back')
      done()
    })

    it('doesNothingAfterPageHasLeft', 0, async (done: Function) => {
      const actions = new TestEvaluationActions()
      actions.active = false
      await submitEvaluationFlow(true, actions)
      expect(actions.events.length).assertEqual(0)
      done()
    })

    it('lateSaveDoesNotPopAnotherPage', 0, async (done: Function) => {
      const actions = new TestEvaluationActions()
      actions.leaveWhileSaving = true
      await submitEvaluationFlow(true, actions)
      expect(actions.events.join(',')).assertEqual('save')
      done()
    })

    it('nonDemoRemoteFailureDoesNotSaveOrNavigate', 0, async (done: Function) => {
      const actions = new TestEvaluationActions()
      actions.failRemote = true
      let failed: boolean = false
      try {
        await submitEvaluationFlow(false, actions)
      } catch {
        failed = true
      }
      expect(failed).assertTrue()
      expect(actions.events.join(',')).assertEqual('remote')
      done()
    })

    it('nonDemoReturnsOnlyAfterRemoteAndLocalSuccess', 0, async (done: Function) => {
      const actions = new TestEvaluationActions()
      await submitEvaluationFlow(false, actions)
      expect(actions.events.join(',')).assertEqual('remote,save,back')
      done()
    })
  })
}
