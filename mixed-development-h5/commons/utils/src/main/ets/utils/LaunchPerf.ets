import { hilog } from '@kit.PerformanceAnalysisKit'

const DOMAIN: number = 0x0000
const TAG: string = 'LaunchPerf'

/**
 * 冷启动耗时打点：按首次出现的顺序记录里程碑，并在 report 时输出相邻耗时。
 * 只统计首次 mark，重复调用同一里程碑会被忽略，避免下拉刷新等场景污染数据。
 */
export class LaunchPerf {
  private static readonly marks: Map<string, number> = new Map<string, number>()

  static mark(name: string): void {
    if (LaunchPerf.marks.has(name)) {
      return
    }
    LaunchPerf.marks.set(name, Date.now())
    hilog.info(DOMAIN, TAG, 'MARK %{public}s', name)
  }

  static report(): void {
    const names: string[] = Array.from(LaunchPerf.marks.keys())
    if (names.length < 2) {
      return
    }
    const total: number = (LaunchPerf.marks.get(names[names.length - 1]) ?? 0) -
      (LaunchPerf.marks.get(names[0]) ?? 0)
    for (let index: number = 1; index < names.length; index++) {
      const from: number = LaunchPerf.marks.get(names[index - 1]) ?? 0
      const to: number = LaunchPerf.marks.get(names[index]) ?? 0
      hilog.info(DOMAIN, TAG, 'STEP %{public}s -> %{public}s = %{public}dms',
        names[index - 1], names[index], to - from)
    }
    hilog.info(DOMAIN, TAG, 'TOTAL %{public}s -> %{public}s = %{public}dms',
      names[0], names[names.length - 1], total)
  }
}
