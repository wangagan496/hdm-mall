import { CustomerServiceView } from 'mine'

@Entry
@Component
struct Index {
  @Provide stackPath: NavPathStack = new NavPathStack()

  build() {
    Navigation(this.stackPath) {
      CustomerServiceView()
    }
    .mode(NavigationMode.Stack)
    .hideTitleBar(true)
  }
}