import { vibrator } from '@kit.SensorServiceKit'

class SensorPlugin {
  async vibrate(): Promise<void> {
    try {
      await vibrator.startVibration({ type: 'time', duration: 500 }, { usage: 'touch' })
    } catch {
    }
  }
}

export const sensorPlugin = new SensorPlugin()
