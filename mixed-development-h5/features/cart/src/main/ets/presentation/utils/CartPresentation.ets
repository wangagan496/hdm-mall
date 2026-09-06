import { AddressItem, CartGoodsModel } from 'models'

export function normalizeCheckoutAddress(address: AddressItem): AddressItem {
  return address
}

export function excludeCartItems(cartList: CartGoodsModel[], skuIds: string[]): CartGoodsModel[] {
  return cartList.filter((item: CartGoodsModel) => !skuIds.includes(item.skuId))
}
