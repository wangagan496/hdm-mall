import { speechRecognizer } from '@kit.CoreSpeechKit'
import { util } from '@kit.ArkTS'

export class SpeechToTextManager {
  engine: speechRecognizer.SpeechRecognitionEngine | null = null
  sessionId: string = ''
  onTextRecognized?: (text: string) => void
  private generation: number = 0
  private preparing?: Promise<void>
  private completion?: Promise<string>
  private resolveResult?: (text: string) => void
  private rejectResult?: (error: Error) => void
  private finalParts: string[] = []
  private timeout: number = -1
  private resultCompleted: boolean = false

  createEngine(): Promise<void> {
    if (this.engine) return Promise.resolve()
    if (this.preparing) return this.preparing
    const generation: number = this.generation
    const extraParam: Record<string, Object> = { 'locate': 'CN', 'recognizerMode': 'short' }
    const parameters: speechRecognizer.CreateEngineParams = { language: 'zh-CN', online: 1, extraParams: extraParam }
    this.preparing = speechRecognizer.createEngine(parameters).then((engine) => {
      if (generation !== this.generation) {
        engine.shutdown()
        throw new Error('语音操作已取消')
      }
      this.engine = engine
    }).finally(() => {
      if (generation === this.generation) this.preparing = undefined
    })
    return this.preparing
  }

  async startRecognition(onRecognized?: (text: string) => void): Promise<void> {
    const generation: number = this.generation
    await this.createEngine()
    if (generation !== this.generation || !this.engine) throw new Error('语音操作已取消')
    this.sessionId = util.generateRandomUUID()
    this.onTextRecognized = onRecognized
    this.finalParts = []
    this.resultCompleted = false
    this.completion = new Promise<string>((resolve, reject) => {
      this.resolveResult = resolve
      this.rejectResult = reject
    })
    // 识别错误可能先于松手；暂存失败供 stopRecognition 等待，不产生未处理拒绝。
    this.completion.catch(() => {})
    this.setListener()
    const parameters: speechRecognizer.StartParams = {
      sessionId: this.sessionId,
      audioInfo: { audioType: 'pcm', sampleRate: 16000, soundChannel: 1, sampleBit: 16 }
    }
    try {
      this.engine.startListening(parameters)
    } catch {
      this.cancelRecognition()
      throw new Error('语音识别启动失败')
    }
  }

  sendAudio(audioChunk: ArrayBuffer): void {
    try {
      this.engine?.writeAudio(this.sessionId, new Uint8Array(audioChunk))
    } catch {
      this.rejectResult?.(new Error('语音数据发送失败，请重试'))
    }
  }

  async stopRecognition(): Promise<string> {
    const completion = this.completion
    if (!completion || !this.engine) throw new Error('语音尚未开始，请长按重试')
    this.timeout = setTimeout(() => {
      this.rejectResult?.(new Error('语音识别超时，请重试'))
    }, 6000)
    try {
      this.engine.finish(this.sessionId)
      return await completion
    } finally {
      this.cancelRecognition()
    }
  }

  cancelRecognition(): void {
    this.generation++
    if (this.timeout !== -1) clearTimeout(this.timeout)
    this.timeout = -1
    this.rejectResult?.(new Error('语音操作已取消'))
    this.rejectResult = undefined
    this.resolveResult = undefined
    this.completion = undefined
    this.preparing = undefined
    this.onTextRecognized = undefined
    this.sessionId = ''
    const engine = this.engine
    this.engine = null
    try { engine?.shutdown() } catch {}
  }

  private completeResult(): void {
    this.resultCompleted = true
    const text: string = this.finalParts.join('').trim()
    if (text) this.resolveResult?.(text)
    else this.rejectResult?.(new Error('没有识别到完整语音，请重试'))
  }

  setListener(): void {
    const currentSession: string = this.sessionId
    const isCurrent = (sessionId: string): boolean => sessionId === currentSession && sessionId === this.sessionId
    const listener: speechRecognizer.RecognitionListener = {
      onStart: () => {},
      onEvent: () => {},
      onResult: (sessionId: string, result: speechRecognizer.SpeechRecognitionResult) => {
        if (!isCurrent(sessionId) || this.resultCompleted) return
        this.onTextRecognized?.(result.result)
        if (result.isFinal) {
          this.finalParts.push(result.result)
          if (result.isLast) this.completeResult()
        }
      },
      onComplete: (sessionId: string) => {
        // 完成通知不携带文字，不能拿中间结果冒充最终结果。
        if (isCurrent(sessionId) && !this.resultCompleted) this.completeResult()
      },
      onError: (sessionId: string) => {
        if (isCurrent(sessionId)) this.rejectResult?.(new Error('语音识别失败，请重试'))
      }
    }
    this.engine?.setListener(listener)
  }
}
export const speechToTextManager = new SpeechToTextManager()
