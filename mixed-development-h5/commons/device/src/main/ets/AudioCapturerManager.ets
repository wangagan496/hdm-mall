import { audio } from "@kit.AudioKit"

export class AudioCapturerManager {
  capturer: audio.AudioCapturer | null = null
  private readDataCallback: ((bf: ArrayBuffer) => void) | null = null

  async createCapturer() {
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
    this.capturer = await audio.createAudioCapturer(audioCapturerOptions)
  }

  async start(callback: (bf: ArrayBuffer) => void): Promise<void> {
    try {
      if (!this.capturer) {
        await this.createCapturer()
      }
      const readDataCallback = (bf: ArrayBuffer): void => {
        callback(bf)
      }
      this.readDataCallback = readDataCallback
      this.capturer?.on('readData', readDataCallback)
      await this.capturer?.start()
    } catch {
      this.readDataCallback = null
      this.capturer = null
      throw new Error('录音启动失败')
    }
  }

  async stop(): Promise<void> {
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
