import { vibrator } from '@kit.SensorServiceKit'

class SensorPlugin {
  vibrate() {
    vibrator.startVibration({ type: 'time', duration: 500 }, { usage: 'touch' })
  }
}

export const sensorPlugin = new SensorPlugin()
