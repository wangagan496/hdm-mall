import { CartView } from 'cart'

@Entry
@Component
struct Index {
  @Provide stackPath: NavPathStack = new NavPathStack()

  build() {
    Navigation(this.stackPath) {
      CartView()
    }
    .mode(NavigationMode.Stack)
    .hideTitleBar(true)
  }
}