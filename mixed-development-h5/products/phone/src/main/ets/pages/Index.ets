import { HistoryView } from 'mine'

@Entry
@Component
struct Index {
  @Provide stackPath: NavPathStack = new NavPathStack()

  build() {
    Navigation(this.stackPath) {
      HistoryView()
    }
    .mode(NavigationMode.Stack)
    .hideTitleBar(true)
  }
}