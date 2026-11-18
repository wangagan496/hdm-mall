import { GlobalVariable } from 'constants'
import { MODULE_STRUCTURE, ModuleStructureEntry } from './ModuleStructure'

@ComponentV2
struct StructureCard {
  @Param entry: ModuleStructureEntry = MODULE_STRUCTURE[0]
  @Param expanded: boolean = false
  @Event onToggle: () => void = () => {}
  build() {
    Column({ space: 8 }) {
      Row() {
        Text(this.entry.title).fontSize(16).fontWeight(500).fontColor($r('[ui_components].color.black')).layoutWeight(1)
        Text(this.expanded ? '收起' : '职责 ›').fontSize(13).fontColor($r('[ui_components].color.gray'))
      }
      Text(this.entry.path).fontSize(12).fontColor($r('[ui_components].color.gray')).width('100%')
      if (this.entry.core) { Text('核心不可拆').fontSize(13).fontColor($r('[ui_components].color.red')).width('100%') }
      if (this.expanded) {
        Text(this.entry.responsibility).fontSize(14).fontColor($r('[ui_components].color.black')).width('100%')
        Text('工程类型：' + this.entry.type).fontSize(12).fontColor($r('[ui_components].color.gray')).width('100%')
        if (this.entry.core) { Text(this.entry.core).fontSize(13).fontColor($r('[ui_components].color.red')).width('100%') }
      }
    }.padding(16).width('100%').backgroundColor($r('[ui_components].color.white')).borderRadius(12)
    .id('structure-' + this.entry.name).onClick(() => this.onToggle())
  }
}

@ComponentV2
export struct ModuleBayView {
  @Local entries: ModuleStructureEntry[] = MODULE_STRUCTURE
  @Local expandedPath: string = ''
  @Local paths: NavPathStack = new NavPathStack()
  @Local safeTop: number = AppStorage.get<number>(GlobalVariable.SAFE_AREA_TOP) || 0
  @Local safeBottom: number = AppStorage.get<number>(GlobalVariable.SAFE_AREA_BOTTOM) || 0
  @Computed
  get structureSummary(): string {
    return this.entries.filter((entry: ModuleStructureEntry) => entry.group === 'shell').length + ' 个壳 · ' +
      this.entries.filter((entry: ModuleStructureEntry) => entry.group === 'feature').length + ' 个功能包 · ' +
      this.entries.filter((entry: ModuleStructureEntry) => entry.group === 'common').length + ' 个基础包'
  }
  build() {
    // 由现有壳的 Navigation 承载，沿用同一 NavPathStack。
    NavDestination() {
      Column({ space: 12 }) {
        Row() {
          Button('返回').fontSize(14).fontColor($r('[ui_components].color.black')).backgroundColor(Color.Transparent)
            .onClick(() => this.paths.pop())
          Text('拆开看看').fontSize(20).fontWeight(500).fontColor($r('[ui_components].color.black')).layoutWeight(1)
        }.height(48).width('100%').backgroundColor($r('[ui_components].color.white'))
        Text(this.structureSummary).id('module-structure-summary').fontSize(16).fontWeight(500)
          .fontColor($r('[ui_components].color.black')).width('100%').padding({ left: 16 })
        Text('钱、库存、订单核心不可拆，始终由同一事务保护。').fontSize(14).fontColor($r('[ui_components].color.red')).padding({ left: 16, right: 16 }).width('100%')
        Text('这里展示工程的真实分工，点开查看每块负责什么。').fontSize(13).fontColor($r('[ui_components].color.gray')).padding({ left: 16, right: 16 }).width('100%')
        List({ space: 8 }) {
          ForEach(this.entries, (entry: ModuleStructureEntry) => {
            ListItem() {
              StructureCard({ entry, expanded: this.expandedPath === entry.path,
                onToggle: () => { this.expandedPath = this.expandedPath === entry.path ? '' : entry.path } })
            }
          }, (entry: ModuleStructureEntry) => entry.path)
        }.layoutWeight(1).padding({ left: 12, right: 12 }).width('100%').scrollBar(BarState.Off)
      }.width('100%').height('100%').backgroundColor($r('[ui_components].color.under')).padding({ top: this.safeTop, bottom: this.safeBottom })
    }.hideTitleBar(true).onReady((context: NavDestinationContext) => { this.paths = context.pathStack })
  }
}

@Builder
export function ModuleBayViewBuilder() { ModuleBayView() }
