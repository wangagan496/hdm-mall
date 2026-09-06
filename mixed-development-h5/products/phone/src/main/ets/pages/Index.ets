import { FavoritesView } from 'mine'

@Entry
@Component
struct Index {
  @Provide stackPath: NavPathStack = new NavPathStack()

  build() {
    Navigation(this.stackPath) {
      FavoritesView()
    }
    .mode(NavigationMode.Stack)
    .hideTitleBar(true)
  }
}