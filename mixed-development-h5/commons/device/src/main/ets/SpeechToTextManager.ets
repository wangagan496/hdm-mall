import { speechRecognizer } from "@kit.CoreSpeechKit"
import { hilog } from '@kit.PerformanceAnalysisKit'

const DOMAIN = 0x0000
const TAG = 'HDM_SpeechToText'

export class SpeechToTextManager {
  engine: speechRecognizer.SpeechRecognitionEngine | null = null
  sessionId: string = "123456"
  textCallBack?: (text: string) => void

  async createEngine(): Promise<void> {
    try {
      const extraParam: Record<string, Object> = { "locate": "CN", "recognizerMode": "short" }
      const initParamsInfo: speechRecognizer.CreateEngineParams = {
        language: 'zh-CN',
        online: 1,
        extraParams: extraParam
      }
      this.engine = await speechRecognizer.createEngine(initParamsInfo)
    } catch {
      this.engine = null
      throw new Error('语音引擎创建失败')
    }
  }

  async init(callBack?: (text: string) => void): Promise<void> {
    this.textCallBack = callBack
    if (!this.engine) {
      await this.createEngine()
    }
    try {
      this.setListener()
      const recognizerParams: speechRecognizer.StartParams = {
        sessionId: this.sessionId,
        audioInfo: {
          audioType: 'pcm',
          sampleRate: 16000,
          soundChannel: 1,
          sampleBit: 16
        }
      }
      this.engine?.startListening(recognizerParams)
    } catch {
      this.engine = null
      throw new Error('语音识别启动失败')
    }
  }

  start(bf: ArrayBuffer): void {
    try {
      this.engine?.writeAudio(this.sessionId, new Uint8Array(bf))
    } catch {
    }
  }

  stop(): void {
    try {
      this.engine?.finish(this.sessionId)
    } catch {
    }
    try {
      this.engine?.shutdown()
    } catch {
    }
    this.engine = null
  }

  setListener() {
    let setListener: speechRecognizer.RecognitionListener = {
      onStart(sessionId: string, eventMessage: string) {
        hilog.info(DOMAIN, TAG, '%{public}s', `onStart, sessionId: ${sessionId} eventMessage: ${eventMessage}`)
      },
      onEvent(sessionId: string, eventCode: number, eventMessage: string) {
        hilog.info(DOMAIN, TAG, '%{public}s', `onEvent, sessionId: ${sessionId} eventCode: ${eventCode} eventMessage: ${eventMessage}`)
      },
      onResult: (sessionId: string, result: speechRecognizer.SpeechRecognitionResult) => {
        hilog.info(DOMAIN, TAG, '%{public}s', 'Speech recognition result: ' + result.result)
        if (this.textCallBack) {
          this.textCallBack(result.result)
        }
      },
      onComplete(sessionId: string, eventMessage: string) {
        hilog.info(DOMAIN, TAG, '%{public}s', `onComplete, sessionId: ${sessionId} eventMessage: ${eventMessage}`)
      },
      onError(sessionId: string, errorCode: number, errorMessage: string) {
        hilog.error(DOMAIN, TAG, '%{public}s', `onError, sessionId: ${sessionId} errorCode: ${errorCode} errorMessage: ${errorMessage}`)
      }
    }
    try {
      this.engine?.setListener(setListener)
    } catch {
    }
  }
}

export const speechToTextManager = new SpeechToTextManager()
