import { MineView } from 'mine'

@Entry
@Component
struct Index {
  @Provide stackPath: NavPathStack = new NavPathStack()

  build() {
    Navigation(this.stackPath) {
      MineView()
    }
    .mode(NavigationMode.Stack)
    .hideTitleBar(true)
  }
}