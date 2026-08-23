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

  getValue(breakPoint: string): T {
    return (this.options as Record<string, T>)[breakPoint]
  }
}
