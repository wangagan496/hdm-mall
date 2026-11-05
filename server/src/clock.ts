export interface Clock { now(): number }

// 每个 app 可独立注入；默认不修改进程全局时间。
export const systemClock: Clock = { now: () => Date.now() }
