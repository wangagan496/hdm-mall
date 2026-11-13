import { ComponentContent, UIContext } from '@kit.ArkUI'

class ConsentDialogParams {
  message: string
  choose: (index: number) => void
  constructor(message: string, choose: (index: number) => void) { this.message = message; this.choose = choose }
}

@Builder
function consentDialogContent(params: ConsentDialogParams) {
  Column({ space: 20 }) {
    Text('隐私与协议').fontSize(22).fontWeight(FontWeight.Medium).fontColor($r('app.color.consent_text'))
    Text(params.message).fontSize(16).lineHeight(24).width('100%').fontColor($r('app.color.consent_text'))
    Row({ space: 12 }) {
      Text('隐私政策全文').fontSize(16).fontColor($r('app.color.consent_action')).decoration({ type: TextDecorationType.Underline })
        .onClick(() => params.choose(0))
      Text('用户协议全文').fontSize(16).fontColor($r('app.color.consent_action')).decoration({ type: TextDecorationType.Underline })
        .onClick(() => params.choose(1))
    }.width('100%').justifyContent(FlexAlign.Center)
    Row({ space: 12 }) {
      ForEach(['不同意', '同意'], (label: string, index: number) => {
        Button(label).layoutWeight(1).height(48).fontSize(17).fontColor($r('app.color.consent_action')).backgroundColor($r('app.color.consent_surface'))
          .border({ width: 1, color: $r('app.color.consent_action') }).onClick(() => params.choose(index + 2))
      })
    }.width('100%')
  }.width('100%').padding(24).backgroundColor($r('app.color.consent_surface')).borderRadius(24)
}

export function showConsentDialog(ui: UIContext, message: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled: boolean = false
    const content = new ComponentContent(ui, wrapBuilder(consentDialogContent), new ConsentDialogParams(message, (index: number) => {
      if (settled) return
      settled = true
      ui.getPromptAction().closeCustomDialog(content).then(() => { content.dispose(); resolve(index) })
        .catch((error: Error) => { content.dispose(); reject(error) })
    }))
    ui.getPromptAction().openCustomDialog(content, { autoCancel: false, alignment: DialogAlignment.Center,
      onWillDismiss: () => {} }).catch((error: Error) => { content.dispose(); reject(error) })
  })
}
