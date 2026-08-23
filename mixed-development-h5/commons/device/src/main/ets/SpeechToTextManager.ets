import { speechRecognizer } from "@kit.CoreSpeechKit"

export class SpeechToTextManager {
  engine: speechRecognizer.SpeechRecognitionEngine | null = null
  sessionId: string = "123456"
  textCallBack?: (text: string) => void

  async createEngine() {
    let extraParam: Record<string, Object> = { "locate": "CN", "recognizerMode": "short" }
    let initParamsInfo: speechRecognizer.CreateEngineParams = {
      language: 'zh-CN',
      online: 1,
      extraParams: extraParam
    }
    this.engine = await speechRecognizer.createEngine(initParamsInfo)
  }

  async init(callBack?: (text: string) => void) {
    this.textCallBack = callBack
    if (!this.engine) {
      await this.createEngine()
    }
    this.setListener()
    let recognizerParams: speechRecognizer.StartParams = {
      sessionId: this.sessionId,
      audioInfo: {
        audioType: 'pcm',
        sampleRate: 16000,
        soundChannel: 1,
        sampleBit: 16
      }
    }
    this.engine?.startListening(recognizerParams)
  }

  start(bf: ArrayBuffer) {
    this.engine?.writeAudio(this.sessionId, new Uint8Array(bf))
  }

  stop() {
    this.engine?.finish(this.sessionId)
    this.engine?.shutdown()
    this.engine = null
  }

  setListener() {
    let setListener: speechRecognizer.RecognitionListener = {
      onStart(sessionId: string, eventMessage: string) {
        console.info(`onStart, sessionId: ${sessionId} eventMessage: ${eventMessage}`)
      },
      onEvent(sessionId: string, eventCode: number, eventMessage: string) {
        console.info(`onEvent, sessionId: ${sessionId} eventCode: ${eventCode} eventMessage: ${eventMessage}`)
      },
      onResult: (sessionId: string, result: speechRecognizer.SpeechRecognitionResult) => {
        console.info('Speech recognition result: ' + result.result)
        if (this.textCallBack) {
          this.textCallBack(result.result)
        }
      },
      onComplete(sessionId: string, eventMessage: string) {
        console.info(`onComplete, sessionId: ${sessionId} eventMessage: ${eventMessage}`)
      },
      onError(sessionId: string, errorCode: number, errorMessage: string) {
        console.error(`onError, sessionId: ${sessionId} errorCode: ${errorCode} errorMessage: ${errorMessage}`)
      }
    }
    this.engine?.setListener(setListener)
  }
}

export const speechToTextManager = new SpeechToTextManager()
