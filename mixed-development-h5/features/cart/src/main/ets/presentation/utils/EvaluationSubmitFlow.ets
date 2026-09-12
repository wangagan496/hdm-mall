export interface EvaluationSubmitActions {
  submitRemote: () => Promise<void>
  saveLocal: () => Promise<void>
  isActive: () => boolean
  returnToPrevious: () => void
}

/** 演示评价以本地保存为完成条件，不等待无契约的远程评价接口。 */
export async function submitEvaluationFlow(demo: boolean, actions: EvaluationSubmitActions): Promise<void> {
  if (!actions.isActive()) {
    return
  }
  if (!demo) {
    await actions.submitRemote()
    if (!actions.isActive()) {
      return
    }
  }
  await actions.saveLocal()
  if (actions.isActive()) {
    actions.returnToPrevious()
  }
}
