import { AddressView } from 'mine'

@Entry
@Component
struct Index {
  @Provide stackPath: NavPathStack = new NavPathStack()

  build() {
    Navigation(this.stackPath) {
      AddressView()
    }
    .mode(NavigationMode.Stack)
    .hideTitleBar(true)
  }
}