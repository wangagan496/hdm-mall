// Only schedules caller-supplied reads. Each run is bounded and cannot overlap itself.
export class RecoveryQuery {
  private timer: number = -1
  private generation: number = 0
  private running: boolean = false
  private attempt: number = 0
  private startedAt: number = 0
  private delays: number[] = [2000, 5000, 10000, 20000, 30000, 60000]

  cancel(): void {
    this.generation++
    if (this.timer !== -1) clearTimeout(this.timer)
    this.timer = -1
    this.running = false
  }

  start(read: () => Promise<boolean>, finished: () => void, delays?: number[], maxMillis: number = 180000): void {
    this.cancel()
    this.attempt = 0
    this.startedAt = Date.now()
    if (delays) this.delays = delays
    this.schedule(this.generation, read, finished, maxMillis)
  }

  private schedule(generation: number, read: () => Promise<boolean>, finished: () => void, maxMillis: number): void {
    if (generation !== this.generation) return
    const delay: number = this.delays[this.attempt]
    if (this.attempt >= this.delays.length || Date.now() - this.startedAt + delay > maxMillis) {
      finished()
      return
    }
    this.attempt++
    this.timer = setTimeout(async () => {
      this.timer = -1
      if (generation !== this.generation || this.running) return
      if (Date.now() - this.startedAt >= maxMillis) { finished(); return }
      this.running = true
      let done: boolean = false
      try { done = await read() } catch { }
      if (generation !== this.generation) return
      this.running = false
      if (done) finished()
      else this.schedule(generation, read, finished, maxMillis)
    }, delay)
  }
}
