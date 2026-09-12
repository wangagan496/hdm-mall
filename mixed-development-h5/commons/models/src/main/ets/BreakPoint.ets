export enum BreakPointEnum {
  xs = "xs",
  sm = "sm",
  md = "md",
  lg = "lg"
}

interface BreakPointValue<T> {
  xs?: T
  sm?: T
  md?: T
  lg?: T
}

export class BreakPointType<T> {
  options: BreakPointValue<T>

  constructor(opt: BreakPointValue<T>) {
    this.options = opt
  }

  /**
   * 断点尚未写入 AppStorage（首帧为空字符串）或未配置对应档位时，按 sm → md → lg → xs 取最近的可用值，
   * 避免把 undefined 交给 columnsTemplate / barPosition 之类的属性。
   */
  getValue(breakPoint: string): T {
    const options = this.options as Record<string, T | undefined>
    const matched: T | undefined = options[breakPoint]
    if (matched !== undefined) {
      return matched
    }
    return (options[BreakPointEnum.sm] ?? options[BreakPointEnum.md] ?? options[BreakPointEnum.lg] ?? options[BreakPointEnum.xs]) as T
  }
}
