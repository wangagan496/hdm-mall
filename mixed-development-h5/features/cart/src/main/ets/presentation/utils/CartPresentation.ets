import { AddressItem, CartGoodsModel } from 'models'

const INVALID_DEMO_ADDRESS_TEXT: string = 'Hello恭喜发财'

export function normalizeCheckoutAddress(address: AddressItem): AddressItem {
  const hasInvalidDemoText = address.address.includes(INVALID_DEMO_ADDRESS_TEXT) ||
    address.receiver.includes(INVALID_DEMO_ADDRESS_TEXT) ||
    address.contact.includes(INVALID_DEMO_ADDRESS_TEXT) ||
    address.fullLocation.includes(INVALID_DEMO_ADDRESS_TEXT)
  if (!hasInvalidDemoText) {
    return address
  }

  return {
    address: '张江路88号创智中心2号楼1208室',
    contact: '138****5678',
    fullLocation: '上海市 浦东新区',
    id: address.id,
    isDefault: address.isDefault,
    receiver: '李晓明',
    provinceCode: address.provinceCode,
    cityCode: address.cityCode,
    countyCode: address.countyCode
  }
}

export function excludeCartItems(cartList: CartGoodsModel[], skuIds: string[]): CartGoodsModel[] {
  return cartList.filter((item: CartGoodsModel) => !skuIds.includes(item.skuId))
}
