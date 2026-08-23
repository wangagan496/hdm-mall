import hilog from '@ohos.hilog'

const DOMAIN = 0x0000
const TAG = 'HDM_'

export class Logger {
  static debug(format: string, ...args: string[]) {
    hilog.debug(DOMAIN, TAG, format, args)
  }

  static info(format: string, ...args: string[]) {
    hilog.info(DOMAIN, TAG, format, args)
  }

  static warn(format: string, ...args: string[]) {
    hilog.warn(DOMAIN, TAG, format, args)
  }

  static error(format: string, ...args: string[]) {
    hilog.error(DOMAIN, TAG, format, args)
  }
}
