import { audio } from "@kit.AudioKit"

export class AudioCapturerManager {
  capturer: audio.AudioCapturer | null = null

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

  async start(callback: (bf: ArrayBuffer) => void) {
    if (!this.capturer) {
      await this.createCapturer()
    }
    this.capturer?.on("readData", (bf) => {
      callback(bf)
    })
    this.capturer?.start()
  }

  async stop() {
    if (this.capturer) {
      await this.capturer.stop()
      await this.capturer.release()
      this.capturer = null
    }
  }
}

export const audioCapturerManager = new AudioCapturerManager()
