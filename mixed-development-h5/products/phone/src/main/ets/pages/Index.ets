import { CategoryView } from 'category'

@Entry
@Component
struct Index {
  @Provide stackPath: NavPathStack = new NavPathStack()

  build() {
    Navigation(this.stackPath) {
      CategoryView({ isActive: true })
    }
    .mode(NavigationMode.Stack)
    .hideTitleBar(true)
  }
}