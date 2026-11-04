import { audio } from '@kit.AudioKit';
import { common } from '@kit.AbilityKit';
import { speechRecognizer } from '@kit.CoreSpeechKit';
import { accessManager, audioCapturerManager, PermissionOutcome, speechToTextManager } from 'device';
import { vibrator } from '@kit.SensorServiceKit';

export enum VoiceState {
  IDLE,
  LISTENING,
  START_FAILED,
  PROCESSING
}

@Preview
@Component
export struct HDMAudioSearch {
  @State voiceState: VoiceState = VoiceState.IDLE
  @State
  scaleValue: number = 1
  @State
  recognizedText: string = ''
  audioCapturer: audio.AudioCapturer | null = null
  asrEngine: speechRecognizer.SpeechRecognitionEngine | null = null
  onChange: (recognizedText: string) => void = () => {
  }
  onComplete: (recognizedText: string) => void = () => {
  }

  private active: boolean = false
  private holding: boolean = false
  private operation: number = 0
  private starting?: Promise<void>

  private async startVoiceRecognition(sequence: number): Promise<void> {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext
    try {
      const outcome: PermissionOutcome = await accessManager.runWithPermissions(context, ['ohos.permission.MICROPHONE'], () => {})
      if (!this.active || sequence !== this.operation) return
      if (!outcome.granted) {
        this.holding = false
        this.voiceState = VoiceState.IDLE
        this.scaleValue = 1
        this.getUIContext().getPromptAction().showToast({ message: '请在设置中开启麦克风权限' })
        return
      }
      if (outcome.prompted) {
        this.holding = false
        this.voiceState = VoiceState.IDLE
        this.scaleValue = 1
        this.getUIContext().getPromptAction().showToast({ message: '已授权，请重新长按说话' })
        return
      }
      if (!this.holding) return
      await speechToTextManager.startRecognition((text: string) => {
        if (this.active && sequence === this.operation) this.recognizedText = text
      })
      if (!this.active || !this.holding || sequence !== this.operation) {
        speechToTextManager.cancelRecognition()
        return
      }
      await audioCapturerManager.start((chunk: ArrayBuffer) => {
        if (this.holding && sequence === this.operation) speechToTextManager.sendAudio(chunk)
      })
      if (!this.active || !this.holding || sequence !== this.operation) {
        await audioCapturerManager.stop()
        speechToTextManager.cancelRecognition()
        return
      }
      this.voiceState = VoiceState.LISTENING
      this.scaleValue = 1.5
      void vibrator.startVibration({ type: 'time', duration: 200 }, { id: 0, usage: 'media' }).catch(() => {})
    } catch (error) {
      if (sequence !== this.operation) return
      speechToTextManager.cancelRecognition()
      await audioCapturerManager.stop()
      if (this.active) {
        this.voiceState = VoiceState.START_FAILED
        this.getUIContext().getPromptAction().showToast({ message: (error as Error).message })
      }
    }
  }

  requestMicrophoneAndStart(): void {
    if (this.starting || this.voiceState === VoiceState.LISTENING || this.voiceState === VoiceState.PROCESSING) return
    this.holding = true
    this.recognizedText = ''
    const sequence: number = ++this.operation
    this.starting = this.startVoiceRecognition(sequence).finally(() => { this.starting = undefined })
  }

  async stopVoiceRecognition(): Promise<void> {
    const sequence: number = this.operation
    this.holding = false
    await this.starting
    if (!this.active || sequence !== this.operation) return
    this.scaleValue = 1
    if (this.voiceState !== VoiceState.LISTENING) {
      speechToTextManager.cancelRecognition()
      return
    }
    this.voiceState = VoiceState.PROCESSING
    await audioCapturerManager.stop()
    try {
      const finalText: string = await speechToTextManager.stopRecognition()
      if (!this.active || sequence !== this.operation) return
      const keyword: string = finalText.replace(/[?!,。]/g, '').trim()
      if (!keyword) throw new Error('没有识别到完整语音，请重试')
      this.voiceState = VoiceState.IDLE
      this.onComplete(keyword)
    } catch (error) {
      if (this.active && sequence === this.operation) {
        this.voiceState = VoiceState.START_FAILED
        this.getUIContext().getPromptAction().showToast({ message: (error as Error).message })
      }
    }
  }

  private cancelVoice(): void {
    this.operation++
    this.holding = false
    this.scaleValue = 1
    speechToTextManager.cancelRecognition()
    void audioCapturerManager.stop()
    try { void vibrator.stopVibration(vibrator.VibratorStopMode.VIBRATOR_STOP_MODE_TIME).catch(() => {}) } catch {}
    this.voiceState = VoiceState.IDLE
  }

  aboutToAppear(): void {
    this.active = true
    // 当前 SDK 的 createEngine 不申请麦克风；真正采集仍在授权和长按确认后开始。
    void speechToTextManager.createEngine().catch(() => {})
  }

  aboutToDisappear(): void {
    this.active = false
    this.cancelVoice()
  }

  build() {
    Column() {
      if (this.voiceState !== VoiceState.IDLE) {
        Column({ space: 16 }) {
          if (this.voiceState === VoiceState.LISTENING) {
            Text('请说，我在聆听...')
              .fontSize(14)
          } else if (this.voiceState === VoiceState.PROCESSING) {
            Text('正在确认完整语音...').fontSize(14)
          } else if (this.voiceState === VoiceState.START_FAILED && this.recognizedText === '') {
            Text('未检测到语音，请长按按钮重试')
              .fontSize(14)
          }
          Text() {
            Span('你可以这样说：')
            Span('太阳眼镜/冬款连衣裙')
              .fontColor($r('[ui_components].color.gray'))
          }
          .fontSize(12)
        }
        .justifyContent(FlexAlign.Center)
        .height(150)

        // 显示文本内容
        Row() {
          Text(this.recognizedText)
            .fontSize(14)
        }
        .padding(20)
        .width("100%")
        .justifyContent(FlexAlign.Center)
      }

      Blank()
      Button() {
        Row({ space: 4 }) {
          Image($r('sys.media.ohos_ic_public_voice'))
            .width(16)
            .aspectRatio(1)
            .fillColor($r('[ui_components].color.white'))
          if (this.voiceState === VoiceState.LISTENING) {
            Text('松开立即搜索')
              .fontSize(14)
              .fontColor($r('[ui_components].color.white'))
          } else {
            Text('长按语音搜索')
              .fontSize(14)
              .fontColor($r('[ui_components].color.white'))
          }
        }
      }
      .padding({ left: 12, right: 12 })
      .height(36)
      .scale({
        x: this.scaleValue,
        y: this.scaleValue
      })
      .linearGradient({
        angle: 135,
        colors: [[$r('[ui_components].color.linear_begin'), 0], [$r('[ui_components].color.linear_end'), 1]]
      })
      .margin({ bottom: 16 })
      .gesture(
        LongPressGesture()
          .onAction(() => {
            this.requestMicrophoneAndStart()
          })
          .onActionEnd(async () => {
            await this.stopVoiceRecognition()
          })
          .onActionCancel(() => {
            this.cancelVoice()
          }))

    }
    .layoutWeight(1)
    .width('100%')
    .backgroundImage($r('app.media.search_bg'))
    .backgroundImageSize(ImageSize.Contain)
    .backgroundImagePosition(Alignment.Bottom)
    .onVisibleAreaChange([0, 1], (visible: boolean) => {
      if (!visible) this.cancelVoice()
    })
  }
}
