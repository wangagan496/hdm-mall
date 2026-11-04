/** 服务端订单状态码（orderState）。读代码时看名字就知道是哪个状态，不用记数字。 */
export class OrderState {
  /** 订单列表的“全部”栏目，不是真实的订单状态 */
  static readonly ALL_TAB: number = 0
  static readonly AWAITING_PAYMENT: number = 1
  static readonly AWAITING_SHIPMENT: number = 2
  static readonly AWAITING_RECEIPT: number = 3
  static readonly AWAITING_REVIEW: number = 4
  static readonly COMPLETED: number = 5
  static readonly CANCELLED: number = 6
}
