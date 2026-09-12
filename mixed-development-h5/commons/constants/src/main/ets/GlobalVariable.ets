export class GlobalVariable {
  static readonly BREAK_POINT_KEY: string = "break_point"
  static readonly SAFE_AREA_TOP: string = "safe_area_top"
  static readonly SAFE_AREA_BOTTOM: string = "safe_area_bottom"
  static readonly BASE_URL: string = "https://meikou-api.itheima.net"
  static readonly SUCCESS_CODE: string = "1"
  static readonly USER_INFO_KEY: string = "user_info_key"
  static readonly SWITCH_TAB: string = "switch_tab"
  static readonly FORM_ID_LIST: string = "form_id_list"
  static readonly CARD_IMAGE_DATA: string = "card_image_data"
  // UIAbility context 的 AppStorage key，供 network 模块读取（避免循环依赖）
  static readonly ABILITY_CONTEXT_KEY: string = "ability_context"
  /**
   * 演示订单流程开关。
   * 当前对接的是公开演示 API，没有真实的支付回调、发货与评价接口契约。
   * 打开时：支付、提醒发货、确认收货、评价的状态推进由本地覆盖层完成（见 storage/DemoOrderStore），
   * 服务端拒绝这些操作也按本地状态继续走通流程，这是有意的演示行为。
   * 接入真实后端后置为 false，订单状态即完全以服务端为准。
   */
  static readonly DEMO_ORDER_FLOW: boolean = true
}

export class BusinessVariable {
  static readonly CATEGORY_DATA: string = "category"
  static readonly CATEGORY_TARGET_ID: string = "category_target_id"
  static readonly CART_COUNT: string = "cart_count"
  static readonly UPDATE_CART_LIST: string = "update_cart_list"
  static readonly UPDATE_ADDRESS_LIST: string = "update_address_list"
  static readonly UPDATE_HOME_DATA: string = "update_home_data"
  static readonly TO_SEARCH: string = "to_search"
}
