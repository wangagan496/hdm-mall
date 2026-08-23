import { GlobalVariable, PAGE_PATH } from 'constants'
import { SearchRouterParam } from '../../domain/models'
import { HDMAudioSearch } from '../components'

@Preview
@Component
struct SearchView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State keyword: string = ''
  @Consume
  stackPath: NavPathStack

  build() {
    NavDestination() {
      Column() {
        // search
        Row() {
          Image($r('[ui_components].media.ic_public_left'))
            .width(24)
            .aspectRatio(1)
            .fillColor($r('[ui_components].color.white'))
            .margin(13)
            .onClick(() => {
              this.stackPath.pop()
            })
          Search({ placeholder: '商品关键字...', value: this.keyword })
            .searchIcon({ src: $r('[ui_components].media.ic_public_search'), color: $r('[ui_components].color.gray') })
            .placeholderColor($r('[ui_components].color.gray'))
            .placeholderFont({ size: 14 })
            .searchButton('搜索', { fontSize: 14, fontColor: $r('[ui_components].color.red') })
            .backgroundColor($r('[ui_components].color.white'))
            .textFont({ size: 14 })
            .layoutWeight(1)
            .padding(0)
            .margin(0)
            .height(36)
            .caretStyle({ color: $r('[ui_components].color.red') })
            .defaultFocus(true)
            .onSubmit((value) => {
              // 可以跳转到搜索结果页 传递关键字
              // let params: SearchRouterParam = {
              //   keyword: value
              // }
              // this.stackPath.pushPathByName(PAGE_PATH.SEARCH_RESULT_PAGE, params)

              this.stackPath.pushPathByName(PAGE_PATH.SEARCH_RESULT_PAGE, {
                keyword: value
              } as SearchRouterParam)
            })


        }
        .padding({ top: this.topHeight, right: 16 })
        .linearGradient({
          angle: 135,
          colors: [[$r('[ui_components].color.linear_begin'), 0], [$r('[ui_components].color.linear_end'), 1]]
        })

        HDMAudioSearch({
          onComplete: (keyword) => {
            // 直接去搜索就可以了
            this.keyword = keyword
            this.stackPath.pushPathByName(PAGE_PATH.SEARCH_RESULT_PAGE, {
              keyword: keyword
            } as SearchRouterParam)
          }
        })
      }
    }
    .hideTitleBar(true)
  }
}

@Builder
function SearchViewBuilder() {
  SearchView()
}
