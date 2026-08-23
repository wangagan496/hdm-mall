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
    let index = this.totalCount()
    this.originArr.push(...data)
    this.listeners.forEach(listener => {
      listener.onDataAdd(index)
    })
  }
}
