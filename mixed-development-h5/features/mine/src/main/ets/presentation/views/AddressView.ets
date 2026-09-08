import { BusinessVariable, GlobalVariable } from 'constants'
import { AddressItem } from 'models'
import { HDMEmpty, HDMNavBar, HDMConfirm } from 'ui_components'
import { common } from '@kit.AbilityKit'
import { emitter } from '@kit.BasicServicesKit'
import { locationPlugin } from 'device'
import {
  AddressDefaultPayload,
  AddressMutationPayload,
  createAddressAPI,
  deleteAddressAPI,
  getAddressDetailAPI,
  getAddressListAPI,
  updateAddressAPI
} from '../../data/api'

interface AreaNode {
  code: string
  level: number
  name: string
  areaList?: AreaNode[]
}

interface AddressForm {
  id: string
  receiver: string
  contact: string
  provinceCode: number
  cityCode: number
  countyCode: number
  fullLocation: string
  address: string
  isDefault: boolean
}

const EMPTY_FORM: AddressForm = {
  id: '',
  receiver: '',
  contact: '',
  provinceCode: 0,
  cityCode: 0,
  countyCode: 0,
  fullLocation: '',
  address: '',
  isDefault: false
}

function createEmptyForm(): AddressForm {
  return {
    id: EMPTY_FORM.id,
    receiver: EMPTY_FORM.receiver,
    contact: EMPTY_FORM.contact,
    provinceCode: EMPTY_FORM.provinceCode,
    cityCode: EMPTY_FORM.cityCode,
    countyCode: EMPTY_FORM.countyCode,
    fullLocation: EMPTY_FORM.fullLocation,
    address: EMPTY_FORM.address,
    isDefault: EMPTY_FORM.isDefault
  }
}

function addressToForm(address: AddressItem): AddressForm {
  return {
    id: address.id,
    receiver: address.receiver,
    contact: address.contact,
    provinceCode: address.provinceCode,
    cityCode: address.cityCode,
    countyCode: address.countyCode,
    fullLocation: address.fullLocation,
    address: address.address,
    isDefault: address.isDefault === 0
  }
}

@Builder
function AddressViewBuilder() {
  AddressView()
}

@Component
export struct AddressView {
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State addresses: AddressItem[] = []
  @State loading: boolean = false
  @State loadFailed: boolean = false
  @State showEditor: boolean = false
  @State selectingArea: boolean = false
  @State submitting: boolean = false
  @State editorLoading: boolean = false
  @State form: AddressForm = createEmptyForm()
  @State provinces: AreaNode[] = []
  @State cities: AreaNode[] = []
  @State counties: AreaNode[] = []
  @State selectedProvinceCode: string = ''
  @State selectedCityCode: string = ''
  @State selectedCountyCode: string = ''
  @State pendingDeleteId: string = ''
  @State showDeleteConfirm: boolean = false
  @State deleting: boolean = false
  @Consume stackPath: NavPathStack

  private areaLoaded: boolean = false
  // Invalidates detail responses after the user switches editor targets or closes the sheet.
  private editorRequestSequence: number = 0

  @Builder
  DeleteConfirmBuilder() {
    HDMConfirm({
      message: '确定删除这个收货地址吗？',
      onConfirm: async () => {
        if (this.deleting) {
          return
        }
        this.deleting = true
        try {
          await this.confirmDelete()
          this.showDeleteConfirm = false
        } finally {
          this.deleting = false
        }
      },
      onCancel: () => {
        if (!this.deleting) {
          this.showDeleteConfirm = false
        }
      }
    })
  }

  aboutToAppear(): void {
    this.loadAddresses()
  }

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  private async loadAddresses(): Promise<void> {
    if (this.loading) {
      return
    }
    this.loading = true
    this.loadFailed = false
    try {
      this.addresses = await getAddressListAPI()
    } catch {
      this.loadFailed = true
      this.safeToast('地址加载失败，请稍后重试')
    } finally {
      this.loading = false
    }
  }

  private openCreate(): void {
    this.editorRequestSequence++
    const form: AddressForm = createEmptyForm()
    form.isDefault = this.addresses.length === 0
    this.form = form
    this.selectingArea = false
    this.editorLoading = false
    this.showEditor = true
  }

  private async openEdit(address: AddressItem): Promise<void> {
    const requestSequence: number = ++this.editorRequestSequence
    this.form = addressToForm(address)
    this.selectingArea = false
    this.editorLoading = true
    this.showEditor = true
    try {
      const detail: AddressItem = await getAddressDetailAPI(address.id)
      if (requestSequence === this.editorRequestSequence && this.showEditor && this.form.id === address.id && detail.id === address.id) {
        this.form = addressToForm(detail)
      }
    } catch {
      // 列表数据仍然可编辑；详情接口失败不应阻塞已有地址的修改入口。
    } finally {
      if (requestSequence === this.editorRequestSequence) {
        this.editorLoading = false
      }
    }
  }

  private openDelete(address: AddressItem): void {
    this.pendingDeleteId = address.id
    this.showDeleteConfirm = true
  }

  private async confirmDelete(): Promise<void> {
    if (!this.pendingDeleteId) {
      return
    }
    const id: string = this.pendingDeleteId
    this.pendingDeleteId = ''
    try {
      await deleteAddressAPI(id)
      await this.loadAddresses()
      this.notifyAddressUpdated()
      this.safeToast('地址已删除')
    } catch {
      this.safeToast('删除失败，请稍后重试')
    }
  }

  private async setDefault(address: AddressItem): Promise<void> {
    if (address.isDefault === 0) {
      return
    }
    try {
      const payload: AddressDefaultPayload = { isDefault: 0 }
      await updateAddressAPI(address.id, payload)
      await this.loadAddresses()
      this.notifyAddressUpdated()
      this.safeToast('默认地址已更新')
    } catch {
      this.safeToast('默认地址设置失败，请稍后重试')
    }
  }

  private validateForm(): boolean {
    if (!this.form.receiver.trim()) {
      this.safeToast('请输入收货人')
      return false
    }
    if (!this.form.contact.trim() || !/^[0-9*+ -]{6,20}$/.test(this.form.contact.trim())) {
      this.safeToast('请输入正确的联系方式')
      return false
    }
    if (!this.form.provinceCode || !this.form.cityCode || !this.form.countyCode) {
      this.safeToast('请选择完整的所在地区')
      return false
    }
    if (!this.form.address.trim()) {
      this.safeToast('请输入详细地址')
      return false
    }
    return true
  }

  private createPayload(): AddressMutationPayload {
    return {
      receiver: this.form.receiver.trim(),
      contact: this.form.contact.trim(),
      provinceCode: this.form.provinceCode.toString(),
      cityCode: this.form.cityCode.toString(),
      countyCode: this.form.countyCode.toString(),
      address: this.form.address.trim(),
      isDefault: this.form.isDefault ? 0 : 1
    }
  }

  private async saveAddress(): Promise<void> {
    if (this.submitting || !this.validateForm()) {
      return
    }
    this.submitting = true
    try {
      const payload: AddressMutationPayload = this.createPayload()
      if (this.form.id) {
        await updateAddressAPI(this.form.id, payload)
      } else {
        await createAddressAPI(payload)
      }
      this.showEditor = false
      this.editorRequestSequence++
      this.selectingArea = false
      this.editorLoading = false
      await this.loadAddresses()
      this.notifyAddressUpdated()
      this.safeToast('地址保存成功')
    } catch {
      this.safeToast('地址保存失败，请稍后重试')
    } finally {
      this.submitting = false
    }
  }

  private notifyAddressUpdated(): void {
    emitter.emit(BusinessVariable.UPDATE_ADDRESS_LIST)
  }

  private loadAreaData(): boolean {
    if (this.areaLoaded) {
      return this.provinces.length > 0
    }
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext
      const raw: string = locationPlugin.getAreaColumns(context)
      const parsed: AreaNode[] = JSON.parse(raw) as AreaNode[]
      this.provinces = Array.isArray(parsed) ? parsed : []
      this.areaLoaded = true
      return this.provinces.length > 0
    } catch {
      this.areaLoaded = true
      this.provinces = []
      return false
    }
  }

  private openAreaSelection(): void {
    if (!this.loadAreaData()) {
      this.safeToast('地区数据加载失败，请稍后重试')
      return
    }
    this.selectingArea = true
    this.selectedProvinceCode = this.form.provinceCode ? this.form.provinceCode.toString() : ''
    this.selectedCityCode = this.form.cityCode ? this.form.cityCode.toString() : ''
    this.selectedCountyCode = this.form.countyCode ? this.form.countyCode.toString() : ''
    const province: AreaNode | undefined = this.provinces.find((item: AreaNode) => item.code === this.selectedProvinceCode)
    this.cities = province?.areaList || []
    const city: AreaNode | undefined = this.cities.find((item: AreaNode) => item.code === this.selectedCityCode)
    this.counties = city?.areaList || []
  }

  private chooseProvince(area: AreaNode): void {
    this.selectedProvinceCode = area.code
    this.selectedCityCode = ''
    this.selectedCountyCode = ''
    this.cities = area.areaList || []
    this.counties = []
  }

  private chooseCity(area: AreaNode): void {
    this.selectedCityCode = area.code
    this.selectedCountyCode = ''
    this.counties = area.areaList || []
  }

  private chooseCounty(area: AreaNode): void {
    this.selectedCountyCode = area.code
  }

  private confirmAreaSelection(): void {
    const province: AreaNode | undefined = this.provinces.find((item: AreaNode) => item.code === this.selectedProvinceCode)
    const city: AreaNode | undefined = this.cities.find((item: AreaNode) => item.code === this.selectedCityCode)
    const county: AreaNode | undefined = this.counties.find((item: AreaNode) => item.code === this.selectedCountyCode)
    if (!province || !city || !county) {
      this.safeToast('请选择完整的省、市、区')
      return
    }
    this.form.provinceCode = Number(province.code)
    this.form.cityCode = Number(city.code)
    this.form.countyCode = Number(county.code)
    this.form.fullLocation = `${province.name} ${city.name} ${county.name}`
    this.selectingArea = false
  }

  @Builder
  private AddressCard(address: AddressItem) {
    Column({ space: 10 }) {
      Row({ space: 8 }) {
        if (address.isDefault === 0) {
          Text('默认')
            .fontSize(11)
            .fontColor($r('[ui_components].color.white'))
            .backgroundColor($r('[ui_components].color.red'))
            .borderRadius(3)
            .padding({ left: 5, right: 5, top: 2, bottom: 2 })
        }
        Text(`${address.receiver}  ${address.contact}`)
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('[ui_components].color.black'))
      }
      .width('100%')
      Text(`${address.fullLocation} ${address.address}`)
        .fontSize(13)
        .fontColor($r('[ui_components].color.text'))
        .lineHeight(20)
        .width('100%')
      Row() {
        if (address.isDefault !== 0) {
          Text('设为默认')
            .fontSize(12)
            .fontColor($r('[ui_components].color.red'))
            .onClick(() => this.setDefault(address))
        }
        Blank()
        Text('编辑')
          .fontSize(12)
          .fontColor($r('[ui_components].color.gray'))
          .onClick(() => this.openEdit(address))
        Text('删除')
          .fontSize(12)
          .fontColor($r('[ui_components].color.gray'))
          .margin({ left: 20 })
          .onClick(() => this.openDelete(address))
      }
      .width('100%')
    }
    .width('100%')
    .padding(14)
    .backgroundColor($r('[ui_components].color.white'))
    .borderRadius(8)
  }

  @Builder
  private AddressEditorBuilder() {
    if (this.editorLoading) {
      LoadingProgress()
        .width(48)
        .color($r('[ui_components].color.red'))
        .padding({ top: 32, bottom: 32 })
    } else if (this.selectingArea) {
      this.AreaSelectionBuilder()
    } else {
      Column({ space: 10 }) {
        Text(this.form.id ? '编辑收货地址' : '新增收货地址')
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('[ui_components].color.black'))
          .width('100%')
        TextInput({ placeholder: '请输入收货人', text: $$this.form.receiver })
          .height(44)
          .width('100%')
        TextInput({ placeholder: '请输入手机号或联系方式', text: $$this.form.contact })
          .height(44)
          .width('100%')
        Row() {
          Text('所在地区')
            .fontSize(14)
            .fontColor($r('[ui_components].color.text'))
          Blank()
          Text(this.form.fullLocation || '请选择省、市、区')
            .fontSize(14)
            .fontColor(this.form.fullLocation ? $r('[ui_components].color.black') : $r('[ui_components].color.gray'))
        }
        .width('100%')
        .height(44)
        .padding({ left: 12, right: 12 })
        .backgroundColor($r('[ui_components].color.under'))
        .borderRadius(4)
        .onClick(() => this.openAreaSelection())
        TextInput({ placeholder: '请输入详细地址', text: $$this.form.address })
          .height(56)
          .width('100%')
        Row() {
          Checkbox()
            .select(this.form.isDefault)
            .selectedColor($r('[ui_components].color.red'))
            .onClick(() => {
              this.form.isDefault = !this.form.isDefault
            })
          Text('设为默认地址')
            .fontSize(13)
            .fontColor($r('[ui_components].color.text'))
            .margin({ left: 8 })
            .onClick(() => {
              this.form.isDefault = !this.form.isDefault
            })
        }
        .width('100%')
        Button(this.submitting ? '保存中...' : '保存地址')
          .width('100%')
          .height(42)
          .fontSize(14)
          .fontColor($r('[ui_components].color.white'))
          .backgroundColor($r('[ui_components].color.red'))
          .enabled(!this.submitting)
          .onClick(() => this.saveAddress())
      }
      .width('100%')
      .padding({ left: 16, right: 16, bottom: 20 })
    }
  }

  @Builder
  private AreaSelectionBuilder() {
    Column({ space: 10 }) {
      Row() {
        Text('返回')
          .fontSize(14)
          .fontColor($r('[ui_components].color.gray'))
          .onClick(() => {
            this.selectingArea = false
          })
        Text('选择所在地区')
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('[ui_components].color.black'))
        Blank()
        Text('完成')
          .fontSize(14)
          .fontColor($r('[ui_components].color.red'))
          .onClick(() => this.confirmAreaSelection())
      }
      .width('100%')
      Row({ space: 6 }) {
        List() {
          ForEach(this.provinces, (item: AreaNode) => {
            ListItem() {
              Text(item.name)
                .fontSize(13)
                .fontColor(item.code === this.selectedProvinceCode ? $r('[ui_components].color.red') : $r('[ui_components].color.text'))
                .padding({ top: 8, bottom: 8 })
            }
            .onClick(() => this.chooseProvince(item))
          }, (item: AreaNode) => item.code)
        }
        .layoutWeight(1)
        .height(260)
        .scrollBar(BarState.Off)
        List() {
          ForEach(this.cities, (item: AreaNode) => {
            ListItem() {
              Text(item.name)
                .fontSize(13)
                .fontColor(item.code === this.selectedCityCode ? $r('[ui_components].color.red') : $r('[ui_components].color.text'))
                .padding({ top: 8, bottom: 8 })
            }
            .onClick(() => this.chooseCity(item))
          }, (item: AreaNode) => item.code)
        }
        .layoutWeight(1)
        .height(260)
        .scrollBar(BarState.Off)
        List() {
          ForEach(this.counties, (item: AreaNode) => {
            ListItem() {
              Text(item.name)
                .fontSize(13)
                .fontColor(item.code === this.selectedCountyCode ? $r('[ui_components].color.red') : $r('[ui_components].color.text'))
                .padding({ top: 8, bottom: 8 })
            }
            .onClick(() => this.chooseCounty(item))
          }, (item: AreaNode) => item.code)
        }
        .layoutWeight(1)
        .height(260)
        .scrollBar(BarState.Off)
      }
      .width('100%')
    }
    .width('100%')
    .padding({ left: 16, right: 16, bottom: 20 })
  }

  build() {
    NavDestination() {
      Column() {
        HDMNavBar({
          title: '收货地址管理',
          onLeftClick: () => this.stackPath.pop()
        })
        Button('+ 新增地址')
          .width('calc(100% - 24vp)')
          .height(42)
          .margin({ top: 12, bottom: 4 })
          .fontSize(14)
          .fontColor($r('[ui_components].color.white'))
          .backgroundColor($r('[ui_components].color.red'))
          .onClick(() => this.openCreate())
        if (this.loading && this.addresses.length === 0) {
          LoadingProgress()
            .width(48)
            .color($r('[ui_components].color.red'))
            .layoutWeight(1)
        } else if (this.loadFailed && this.addresses.length === 0) {
          HDMEmpty({
            tip: '地址加载失败，请重试',
            buttonText: '重新加载',
            onBtnClick: () => this.loadAddresses()
          })
            .layoutWeight(1)
        } else if (this.addresses.length === 0) {
          HDMEmpty({
            tip: '还没有收货地址',
            buttonText: '新增地址',
            onBtnClick: () => this.openCreate()
          })
            .layoutWeight(1)
        } else {
          List({ space: 8 }) {
            ForEach(this.addresses, (address: AddressItem) => {
              ListItem() {
                this.AddressCard(address)
              }
            }, (address: AddressItem) => address.id)
          }
          .layoutWeight(1)
          .scrollBar(BarState.Off)
          .padding({ left: 12, right: 12, top: 8, bottom: 12 })
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('[ui_components].color.under'))
      .bindSheet($$this.showEditor, this.AddressEditorBuilder(), {
        title: { title: '地址编辑' },
        height: SheetSize.FIT_CONTENT,
        backgroundColor: $r('[ui_components].color.white')
      })
    }
    .hideTitleBar(true)
    .bindContentCover($$this.showDeleteConfirm, this.DeleteConfirmBuilder())
    .padding({ top: this.topHeight })
  }
}
