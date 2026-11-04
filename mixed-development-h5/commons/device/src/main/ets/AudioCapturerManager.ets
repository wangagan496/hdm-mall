import { audio } from "@kit.AudioKit"

export class AudioCapturerManager {
  capturer: audio.AudioCapturer | null = null
  private readDataCallback: ((bf: ArrayBuffer) => void) | null = null
  private generation: number = 0

  async createCapturer(): Promise<audio.AudioCapturer> {
    let audioStreamInfo: audio.AudioStreamInfo = {
      samplingRate: audio.AudioSamplingRate.SAMPLE_RATE_16000,
      channels: audio.AudioChannel.CHANNEL_1,
      sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
      encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW
    }
    let audioCapturerInfo: audio.AudioCapturerInfo = {
      source: audio.SourceType.SOURCE_TYPE_MIC,
      capturerFlags: 0
    }
    let audioCapturerOptions: audio.AudioCapturerOptions = {
      streamInfo: audioStreamInfo,
      capturerInfo: audioCapturerInfo
    }
    return await audio.createAudioCapturer(audioCapturerOptions)
  }

  async start(callback: (bf: ArrayBuffer) => void): Promise<void> {
    const generation: number = ++this.generation
    try {
      const capturer = await this.createCapturer()
      if (generation !== this.generation) {
        await capturer.release()
        return
      }
      this.capturer = capturer
      const readDataCallback = (bf: ArrayBuffer): void => {
        callback(bf)
      }
      this.readDataCallback = readDataCallback
      this.capturer?.on('readData', readDataCallback)
      await this.capturer?.start()
    } catch {
      if (generation === this.generation) await this.stop()
      throw new Error('录音启动失败')
    }
  }

  async stop(): Promise<void> {
    this.generation++
    const currentCapturer = this.capturer
    const currentCallback = this.readDataCallback
    this.capturer = null
    this.readDataCallback = null
    if (!currentCapturer) {
      return
    }
    try {
      if (currentCallback) {
        currentCapturer.off('readData', currentCallback)
      }
    } catch {
    }
    try {
      await currentCapturer.stop()
    } catch {
    }
    try {
      await currentCapturer.release()
    } catch {
    }
  }
}

export const audioCapturerManager = new AudioCapturerManager()
