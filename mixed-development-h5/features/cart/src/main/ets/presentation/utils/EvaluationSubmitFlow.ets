export interface EvaluationSubmitActions {
  submitRemote: () => Promise<void>
  isActive: () => boolean
  returnToOrderList: () => void
}

/** 服务端确认保存后才能返回；失败保留输入，离开页面后不重复导航。 */
export async function submitEvaluationFlow(actions: EvaluationSubmitActions): Promise<void> {
  if (!actions.isActive()) {
    return
  }
  await actions.submitRemote()
  if (actions.isActive()) {
    actions.returnToOrderList()
  }
}
