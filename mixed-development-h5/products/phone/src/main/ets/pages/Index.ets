import { LoginView } from 'mine'

@Entry
@Component
struct Index {
  @Provide stackPath: NavPathStack = new NavPathStack()

  build() {
    Navigation(this.stackPath) {
      LoginView()
    }
    .mode(NavigationMode.Stack)
    .hideTitleBar(true)
  }
}