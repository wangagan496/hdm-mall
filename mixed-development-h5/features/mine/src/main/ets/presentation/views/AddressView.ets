import { BusinessVariable, GlobalVariable, PAGE_PATH } from 'constants'
import { AddressItem, HDMUser } from 'models'
import { HDMEmpty, HDMNavBar, HDMConfirm } from 'ui_components'
import { common } from '@kit.AbilityKit'
import { emitter } from '@kit.BasicServicesKit'
import { util } from '@kit.ArkTS'
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

interface AddressEditorDismiss {
  dismiss: () => void
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
  @StorageProp(GlobalVariable.USER_INFO_KEY) @Watch('reloadForCurrentAccount') user: HDMUser = {} as HDMUser
  @StorageProp(GlobalVariable.SAFE_AREA_TOP)
  topHeight: number = 0
  @State addresses: AddressItem[] = []
  @State loading: boolean = false
  @State loadFailed: boolean = false
  @State showEditor: boolean = false
  @State selectingArea: boolean = false
  @State submitting: boolean = false
  @State saveError: string = ''
  @State closingEditor: boolean = false
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
  private addressSaveTimer: number = -1
  private addressRetryTimer: number = -1
  private addressRetryCount: number = 0
  private savedAddressData: string = ''
  private addressRequestKey: string = ''
  private addressRevision: number = 0
  private pendingAddressSave: Promise<void> | undefined = undefined
  private pageActive: boolean = true
  private pageGeneration: number = 0
  private sessionToken: string = ''
  @State loadedToken: string = ''
  @State checkoutEditor: boolean = false

  @Builder
  DeleteConfirmBuilder() {
    HDMConfirm({
      message: '确定删除这个收货地址吗？',
      confirmText: '删除地址', busy: this.deleting,
      onConfirm: async () => {
        await this.confirmDelete()
      },
      onCancel: () => {
        if (!this.deleting) {
          this.showDeleteConfirm = false
        }
      }
    })
  }

  aboutToAppear(): void {
    this.pageActive = true
    const entries = this.stackPath?.getParamByName?.(PAGE_PATH.ADDRESS_PAGE) as string[] | undefined
    const entry: string = entries && entries.length ? entries[entries.length - 1] : ''
    if (typeof entry === 'string' && entry.startsWith('checkout:')) {
      void this.startCheckoutEditor(entry.slice('checkout:'.length))
      return
    }
    this.loadAddresses()
  }

  private async startCheckoutEditor(addressId: string): Promise<void> {
    this.checkoutEditor = true
    if (!await this.loadAddresses()) return
    const address = this.addresses.find((item: AddressItem) => item.id === addressId)
    if (address) await this.openEdit(address)
    else this.openCreate()
  }

  private async useCheckoutAddress(): Promise<void> {
    const sequence: number = this.editorRequestSequence
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    if (!this.checkoutEditor || this.closingEditor || !this.isCurrentEditor(sequence, generation, token)) return
    this.cancelScheduledSave()
    this.closingEditor = true
    try {
      do {
        await this.saveAddress()
        if (!this.isCurrentEditor(sequence, generation, token)) return
      } while (!this.saveError && !this.addressValidationMessage() && JSON.stringify(this.buildAddressData()) !== this.savedAddressData)
      if (!this.saveError && !this.addressValidationMessage() && this.form.id &&
        JSON.stringify(this.buildAddressData()) === this.savedAddressData) {
        this.stackPath.pop(this.form.id)
      } else if (!this.saveError) this.saveError = this.addressValidationMessage()
    } finally {
      if (this.isCurrentEditor(sequence, generation, token)) this.closingEditor = false
    }
  }

  aboutToDisappear(): void {
    this.pageActive = false
    this.pageGeneration++
    this.addressQuerySequence++
    this.cancelScheduledSave()
    this.editorRequestSequence++
    this.pendingAddressSave = undefined
    this.submitting = false
    this.closingEditor = false
    this.editorLoading = false
    this.loading = false
    this.settingDefaultId = ''
    this.deleting = false
    this.showDeleteConfirm = false
    this.pendingDeleteId = ''
  }

  private reloadForCurrentAccount(): void {
    if ((this.user.token || '') !== this.sessionToken) this.loadAddresses()
  }

  private synchronizeAddressSession(): void {
    const token: string = this.user.token || ''
    if (token === this.sessionToken) return
    this.sessionToken = token
    this.pageGeneration++
    this.addressQuerySequence++
    this.editorRequestSequence++
    this.cancelScheduledSave()
    this.loadedToken = ''
    this.addresses = []
    this.form = createEmptyForm()
    this.savedAddressData = ''
    this.addressRequestKey = ''
    this.addressRevision = 0
    this.pendingAddressSave = undefined
    this.showEditor = false
    this.selectingArea = false
    this.submitting = false
    this.closingEditor = false
    this.editorLoading = false
    this.saveError = ''
    this.refreshError = ''
    this.settingDefaultId = ''
    this.pendingDeleteId = ''
    this.showDeleteConfirm = false
    this.deleting = false
    this.selectedProvinceCode = ''
    this.selectedCityCode = ''
    this.selectedCountyCode = ''
    this.cities = []
    this.counties = []
  }

  private isCurrentAddressSession(generation: number, token: string): boolean {
    return this.pageActive && generation === this.pageGeneration && token.length > 0 &&
      token === this.sessionToken && token === (this.user.token || '')
  }

  private isCurrentEditor(sequence: number, generation: number, token: string): boolean {
    return this.isCurrentAddressSession(generation, token) && sequence === this.editorRequestSequence && this.showEditor
  }

  private canManageAddresses(): boolean {
    return this.isCurrentAddressSession(this.pageGeneration, this.sessionToken) && this.loadedToken === this.sessionToken &&
      !this.loading && !this.loadFailed && !this.submitting && !this.closingEditor && !this.deleting && !this.settingDefaultId
  }

  private safeToast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }

  private addressQuerySequence: number = 0
  @State settingDefaultId: string = ''
  @State refreshError: string = ''

  private async loadAddresses(afterSave: boolean = false): Promise<boolean> {
    this.synchronizeAddressSession()
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    const sequence: number = ++this.addressQuerySequence
    this.loadFailed = false
    if (!this.isCurrentAddressSession(generation, token)) {
      this.loading = false
      return false
    }
    this.loading = true
    try {
      const addresses = await getAddressListAPI(token)
      if (sequence !== this.addressQuerySequence || !this.isCurrentAddressSession(generation, token)) {
        return false
      }
      this.addresses = addresses
      this.loadedToken = token
      this.refreshError = ''
      return true
    } catch {
      if (sequence === this.addressQuerySequence && this.isCurrentAddressSession(generation, token)) {
        this.loadFailed = true
        this.refreshError = afterSave ? '地址已保存，列表刷新失败，请重新加载' : '地址加载失败，请重新加载'
        this.safeToast(this.refreshError)
      }
      return false
    } finally {
      if (sequence === this.addressQuerySequence && this.isCurrentAddressSession(generation, token)) {
        this.loading = false
      }
    }
  }

  private openCreate(): void {
    if (!this.canManageAddresses()) {
      return
    }
    this.cancelScheduledSave()
    this.editorRequestSequence++
    const form: AddressForm = createEmptyForm()
    form.isDefault = !this.checkoutEditor && this.addresses.length === 0
    this.form = form
    this.savedAddressData = JSON.stringify(this.buildAddressData())
    this.addressRequestKey = util.generateRandomUUID(true)
    this.addressRevision = 0
    this.saveError = ''
    this.selectingArea = false
    this.editorLoading = false
    this.showEditor = true
  }

  private async openEdit(address: AddressItem): Promise<void> {
    if (!this.canManageAddresses() || !this.addresses.some((item: AddressItem) => item.id === address.id)) {
      return
    }
    this.cancelScheduledSave()
    const requestSequence: number = ++this.editorRequestSequence
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    this.form = addressToForm(address)
    this.addressRequestKey = util.generateRandomUUID(true)
    this.addressRevision = 0
    this.savedAddressData = JSON.stringify(this.buildAddressData())
    this.saveError = ''
    this.selectingArea = false
    this.editorLoading = true
    this.showEditor = true
    try {
      const detail: AddressItem = await getAddressDetailAPI(address.id, token)
      if (this.isCurrentEditor(requestSequence, generation, token) && this.form.id === address.id && detail.id === address.id) {
        this.form = addressToForm(detail)
        this.savedAddressData = JSON.stringify(this.buildAddressData())
      }
    } catch {
      // 列表数据仍然可编辑；详情接口失败不应阻塞已有地址的修改入口。
    } finally {
      if (this.isCurrentEditor(requestSequence, generation, token)) {
        this.editorLoading = false
      }
    }
  }

  private openDelete(address: AddressItem): void {
    if (!this.canManageAddresses() || !this.addresses.some((item: AddressItem) => item.id === address.id)) return
    this.pendingDeleteId = address.id
    this.showDeleteConfirm = true
  }

  private async confirmDelete(): Promise<void> {
    if (!this.canManageAddresses() || !this.pendingDeleteId ||
      !this.addresses.some((item: AddressItem) => item.id === this.pendingDeleteId)) {
      return
    }
    const id: string = this.pendingDeleteId
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    this.pendingDeleteId = ''
    this.deleting = true
    try {
      await deleteAddressAPI(id, token)
      if (!this.isCurrentAddressSession(generation, token)) return
      await this.loadAddresses()
      if (!this.isCurrentAddressSession(generation, token)) return
      this.notifyAddressUpdated()
      this.safeToast('地址已删除')
    } catch {
      if (this.isCurrentAddressSession(generation, token)) this.safeToast('删除失败，请稍后重试')
    } finally {
      if (this.isCurrentAddressSession(generation, token)) {
        this.showDeleteConfirm = false
        this.deleting = false
      }
    }
  }

  private async setDefault(address: AddressItem): Promise<void> {
    if (address.isDefault === 0 || !this.canManageAddresses() ||
      !this.addresses.some((item: AddressItem) => item.id === address.id)) {
      return
    }
    this.settingDefaultId = address.id
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    try {
      const payload: AddressDefaultPayload = { isDefault: 0 }
      await updateAddressAPI(address.id, payload, token)
      if (!this.isCurrentAddressSession(generation, token)) return
      const refreshed: boolean = await this.loadAddresses(true)
      if (!this.isCurrentAddressSession(generation, token)) return
      this.notifyAddressUpdated()
      if (refreshed) {
        this.safeToast('默认地址已更新')
      }
    } catch {
      if (this.isCurrentAddressSession(generation, token)) this.safeToast('默认地址设置失败，请稍后重试')
    } finally {
      if (this.isCurrentAddressSession(generation, token)) this.settingDefaultId = ''
    }
  }

  private addressValidationMessage(): string {
    if (!this.form.receiver.trim() || this.form.receiver.trim().length > 50) {
      return '请填写收货人，最多50字'
    }
    if (!/^[0-9]{6,20}$/.test(this.form.contact.trim())) {
      return '请填写6至20位数字联系方式'
    }
    if (!this.form.provinceCode || !this.form.cityCode || !this.form.countyCode) {
      return '请选择完整的所在地区'
    }
    if (!this.form.address.trim() || this.form.address.trim().length > 300) {
      return '请填写详细地址，最多300字'
    }
    return ''
  }

  private buildAddressData(): AddressMutationPayload {
    return {
      fullLocation: this.form.fullLocation,
      receiver: this.form.receiver.trim(),
      contact: this.form.contact.trim(),
      provinceCode: this.form.provinceCode.toString(),
      cityCode: this.form.cityCode.toString(),
      countyCode: this.form.countyCode.toString(),
      address: this.form.address.trim(),
      isDefault: this.form.isDefault ? 0 : 1
    }
  }

  private cancelScheduledSave(): void {
    if (this.addressRetryTimer !== -1) clearTimeout(this.addressRetryTimer)
    this.addressRetryTimer = -1
    this.addressRetryCount = 0
    if (this.addressSaveTimer !== -1) {
      clearTimeout(this.addressSaveTimer)
      this.addressSaveTimer = -1
    }
  }

  // 连续输入合并成一次保存；资料没填完整时不发请求，也不打断输入。
  private scheduleAddressSave(): void {
    this.cancelScheduledSave()
    const sequence: number = this.editorRequestSequence
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    if (!this.isCurrentEditor(sequence, generation, token)) return
    this.saveError = ''
    if (!this.showEditor || this.editorLoading || this.selectingArea || this.closingEditor || this.addressValidationMessage()) {
      return
    }
    this.addressSaveTimer = setTimeout(() => {
      if (!this.isCurrentEditor(sequence, generation, token)) return
      this.addressSaveTimer = -1
      this.saveAddress()
    }, 800)
  }

  private async saveAddress(): Promise<void> {
    const sequence: number = this.editorRequestSequence
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    if (!this.isCurrentEditor(sequence, generation, token)) return
    if (this.addressRetryTimer !== -1) clearTimeout(this.addressRetryTimer)
    this.addressRetryTimer = -1
    if (this.pendingAddressSave) {
      await this.pendingAddressSave
      return
    }
    if (!this.showEditor || this.editorLoading || this.selectingArea || this.addressValidationMessage()) {
      return
    }
    const addressData: AddressMutationPayload = this.buildAddressData()
    if (JSON.stringify(addressData) === this.savedAddressData) {
      return
    }
    const task: Promise<void> = this.persistAddress(addressData)
    this.pendingAddressSave = task
    await task
    if (!this.isCurrentEditor(sequence, generation, token) || this.pendingAddressSave !== task) return
    this.pendingAddressSave = undefined
    if (this.saveError && !this.closingEditor && this.addressRetryCount < 3) {
      const delay: number = [2000, 5000, 10000][this.addressRetryCount++]
      this.saveError = '修改尚未确认保存，输入已保留，正在自动重试'
      this.addressRetryTimer = setTimeout(() => {
        this.addressRetryTimer = -1
        if (this.isCurrentEditor(sequence, generation, token)) void this.saveAddress()
      }, delay)
    }
    // 请求期间仍可继续输入；上一份保存成功后再提交最新修改。
    if (!this.saveError && JSON.stringify(this.buildAddressData()) !== this.savedAddressData) {
      this.scheduleAddressSave()
    }
  }

  private async persistAddress(addressData: AddressMutationPayload): Promise<void> {
    const editorSequence: number = this.editorRequestSequence
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    if (!this.isCurrentEditor(editorSequence, generation, token)) return
    this.submitting = true
    this.saveError = ''
    const revision: number = ++this.addressRevision
    try {
      // 已有地址带有编号；新增地址的编号为空。
      const isEditingAddress: boolean = this.form.id !== ''
      if (isEditingAddress) {
        // 按地址编号修改已有地址。
        const requestData: AddressMutationPayload = {
          fullLocation: addressData.fullLocation, receiver: addressData.receiver, contact: addressData.contact,
          provinceCode: addressData.provinceCode, cityCode: addressData.cityCode, countyCode: addressData.countyCode,
          address: addressData.address, isDefault: addressData.isDefault, requestKey: this.addressRequestKey, revision
        }
        await updateAddressAPI(this.form.id, requestData, token)
      } else {
        // 把填写的地址资料保存为一条新地址。
        const createdAddress = await createAddressAPI(addressData, this.addressRequestKey, token, revision)
        if (!createdAddress.id) {
          throw new Error('保存结果缺少地址编号')
        }
        if (!this.isCurrentEditor(editorSequence, generation, token)) {
          return
        }
        this.form.id = createdAddress.id
      }
      if (!this.isCurrentEditor(editorSequence, generation, token)) {
        return
      }
      this.savedAddressData = JSON.stringify(addressData)
      await this.loadAddresses(true)
      if (!this.isCurrentEditor(editorSequence, generation, token)) return
      this.notifyAddressUpdated()
    } catch {
      if (this.isCurrentEditor(editorSequence, generation, token)) {
        this.saveError = '修改未确认保存，请检查网络后重试'
      }
    } finally {
      if (this.isCurrentEditor(editorSequence, generation, token)) this.submitting = false
    }
  }

  private async closeAddressEditor(action: AddressEditorDismiss): Promise<void> {
    const sequence: number = this.editorRequestSequence
    const generation: number = this.pageGeneration
    const token: string = this.sessionToken
    if (this.closingEditor || !this.isCurrentEditor(sequence, generation, token)) {
      return
    }
    // 在地区选择中按返回，只退回表单，不关闭整份地址。
    if (this.selectingArea) {
      this.selectingArea = false
      this.scheduleAddressSave()
      return
    }
    this.closingEditor = true
    this.cancelScheduledSave()
    try {
      // 关闭时立即补存最后输入；等待中的新增完成后，后续修改沿用返回的编号。
      do {
        await this.saveAddress()
        if (!this.isCurrentEditor(sequence, generation, token)) return
      } while (!this.saveError && !this.addressValidationMessage() &&
        JSON.stringify(this.buildAddressData()) !== this.savedAddressData)
      if (JSON.stringify(this.buildAddressData()) === this.savedAddressData) {
        this.closingEditor = false
        this.editorRequestSequence++
        action.dismiss()
      } else {
        this.getUIContext().showAlertDialog({
          title: '还有未保存的修改',
          message: this.saveError || this.addressValidationMessage(),
          primaryButton: { value: '继续编辑', action: () => {} },
          secondaryButton: {
            value: '放弃未保存修改',
            action: () => {
              if (!this.isCurrentEditor(sequence, generation, token)) return
              this.cancelScheduledSave()
              this.closingEditor = false
              this.editorRequestSequence++
              action.dismiss()
            }
          }
        })
      }
    } finally {
      if (this.isCurrentEditor(sequence, generation, token)) this.closingEditor = false
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
      this.areaLoaded = this.provinces.length > 0
      return this.provinces.length > 0
    } catch {
      this.areaLoaded = false
      this.provinces = []
      return false
    }
  }

  private openAreaSelection(): void {
    if (!this.loadAreaData()) {
      this.safeToast('地区数据加载失败，请稍后重试')
      return
    }
    this.cancelScheduledSave()
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
    const province: AreaNode | undefined = this.provinces.find((item: AreaNode) => item.code === this.selectedProvinceCode)
    const city: AreaNode | undefined = this.cities.find((item: AreaNode) => item.code === this.selectedCityCode)
    const county: AreaNode | undefined = this.counties.find((item: AreaNode) => item.code === area.code)
    if (!province || !city || !county) {
      this.safeToast('请选择完整的省、市、区')
      return
    }
    // 选好区县后直接填回编辑框；资料完整时自动保存。
    this.selectedCountyCode = county.code
    this.form.provinceCode = Number(province.code)
    this.form.cityCode = Number(city.code)
    this.form.countyCode = Number(county.code)
    this.form.fullLocation = `${province.name} ${city.name} ${county.name}`
    this.selectingArea = false
    this.scheduleAddressSave()
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
          Text(this.settingDefaultId === address.id ? '正在设置' : '设为默认')
            .fontSize(12)
            .fontColor($r('[ui_components].color.red'))
            .onClick(() => this.setDefault(address))
            .enabled(this.canManageAddresses())
        }
        Blank()
        Text('编辑')
          .enabled(this.canManageAddresses())
          .fontSize(12)
          .fontColor($r('[ui_components].color.gray'))
          .onClick(() => this.openEdit(address))
        Text('删除')
          .enabled(this.canManageAddresses())
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
        TextInput({ placeholder: '请输入收货人', text: this.form.receiver })
          .onChange((value: string) => {
            this.form.receiver = value
            this.scheduleAddressSave()
          })
          .height(44)
          .width('100%')
        TextInput({ placeholder: '请输入手机号或联系方式', text: this.form.contact })
          .onChange((value: string) => {
            this.form.contact = value
            this.scheduleAddressSave()
          })
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
        TextInput({ placeholder: '请输入详细地址', text: this.form.address })
          .onChange((value: string) => {
            this.form.address = value
            this.scheduleAddressSave()
          })
          .height(56)
          .width('100%')
        if (!this.checkoutEditor) {
         Row() {
          Checkbox()
            .select(this.form.isDefault)
            .selectedColor($r('[ui_components].color.red'))
            .onChange((selected: boolean) => {
              this.form.isDefault = selected
              this.scheduleAddressSave()
            })
          Text('设为默认地址')
            .fontSize(13)
            .fontColor($r('[ui_components].color.text'))
            .margin({ left: 8 })
            .onClick(() => {
              this.form.isDefault = !this.form.isDefault
              this.scheduleAddressSave()
            })
        }
        .width('100%')
        }
        if (this.saveError) {
          Text(this.saveError)
            .fontSize(12)
            .fontColor($r('[ui_components].color.red'))
          Text('重试')
            .fontSize(14)
            .fontColor($r('[ui_components].color.red'))
            .onClick(() => this.scheduleAddressSave())
        }
      }
      .enabled(!this.closingEditor)
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
            this.scheduleAddressSave()
          })
        Text('选择所在地区')
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('[ui_components].color.black'))
        Blank()
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
      if (this.checkoutEditor) {
        Column({ space: 12 }) {
          HDMNavBar({ title: '收货地址', onLeftClick: () => {
            void this.closeAddressEditor({ dismiss: () => { this.stackPath.pop() } })
          } })
          if (this.loadFailed) {
            Text('地址加载失败，请返回后重试')
          } else {
            this.AddressEditorBuilder()
            Button(this.submitting ? '保存中…' : '保存并使用此地址').backgroundColor($r('[ui_components].color.under')).fontColor($r('[ui_components].color.text')).border({ width: 1, color: $r('[ui_components].color.border') })
              .enabled(!this.closingEditor && !this.editorLoading && !this.selectingArea)
              .onClick(() => this.useCheckoutAddress())
          }
        }
        .width('100%')
        .backgroundColor($r('[ui_components].color.white'))
      } else {
      Column() {
        HDMNavBar({
          title: '收货地址管理',
          onLeftClick: () => this.stackPath.pop()
        })
        Button('+ 新增地址')
          .enabled(this.canManageAddresses())
          .width('calc(100% - 24vp)')
          .height(42)
          .margin({ top: 12, bottom: 4 })
          .fontSize(14)
          .fontColor($r('[ui_components].color.white'))
          .backgroundColor($r('[ui_components].color.red'))
          .onClick(() => this.openCreate())
        if (this.refreshError && this.addresses.length > 0) {
          Text(this.refreshError + '（点击重试）')
            .fontSize(13)
            .fontColor($r('[ui_components].color.red'))
            .padding(12)
            .onClick(() => this.loadAddresses())
        }
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
            }, (address: AddressItem) => `${address.id}:${JSON.stringify(address)}`)
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
        backgroundColor: $r('[ui_components].color.white'),
        onWillDismiss: (action: DismissSheetAction) => {
          this.closeAddressEditor({ dismiss: () => action.dismiss() })
        },
        onDisappear: () => {
          this.cancelScheduledSave()
          this.editorRequestSequence++
        }
      })
      }
    }
    .hideTitleBar(true)
    .mode(this.checkoutEditor ? NavDestinationMode.DIALOG : NavDestinationMode.STANDARD)
    .onBackPressed(() => {
      if (!this.checkoutEditor) return false
      void this.closeAddressEditor({ dismiss: () => { this.stackPath.pop() } })
      return true
    })
    .bindContentCover($$this.showDeleteConfirm, this.DeleteConfirmBuilder())
    .padding({ top: this.topHeight })
  }
}
