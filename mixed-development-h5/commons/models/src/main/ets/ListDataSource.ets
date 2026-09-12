export class ListDataSource<T> implements IDataSource {
  private originArr: T[] = []
  private listeners: DataChangeListener[] = []

  totalCount(): number {
    return this.originArr.length
  }

  getData(index: number): T {
    return this.originArr[index]
  }

  registerDataChangeListener(listener: DataChangeListener): void {
    if (this.listeners.indexOf(listener) < 0) {
      this.listeners.push(listener)
    }
  }

  unregisterDataChangeListener(listener: DataChangeListener): void {
    let index = this.listeners.indexOf(listener)
    if (index > -1) {
      this.listeners.splice(index, 1)
    }
  }

  loadData(data: T[]) {
    this.originArr = data
    this.listeners.forEach(listener => {
      listener.onDataReloaded()
    })
  }

  addArr(data: T[]) {
    if (data.length === 0) {
      return
    }
    const startIndex: number = this.totalCount()
    this.originArr.push(...data)
    // 一次追加 N 条要把 N 个新位置逐个告知 LazyForEach，只通知首个 index 会让 WaterFlow/Grid 漏掉后面的行。
    // 注：在模拟器上实测 WaterFlow 对 onDatasetChange(ADD, count>1) 只扩大了总数却不创建子节点，这里用逐条 onDataAdd。
    this.listeners.forEach((listener: DataChangeListener) => {
      for (let offset = 0; offset < data.length; offset++) {
        listener.onDataAdd(startIndex + offset)
      }
    })
  }

  replaceArr(startIndex: number, data: T[]): void {
    data.forEach((item: T, offset: number): void => {
      const index: number = startIndex + offset
      if (index >= this.totalCount()) {
        return
      }
      this.originArr[index] = item
      this.listeners.forEach((listener: DataChangeListener): void => {
        listener.onDataChange(index)
      })
    })
  }
}
