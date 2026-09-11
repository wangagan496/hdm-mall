export class GlobalVariable {
  static readonly BREAK_POINT_KEY: string = "break_point"
  static readonly SAFE_AREA_TOP: string = "safe_area_top"
  static readonly SAFE_AREA_BOTTOM: string = "safe_area_bottom"
  static readonly BASE_URL: string = "https://meikou-api.itheima.net"
  // 支付宝沙箱网关：本地 npm run dev 后填本机局域网 IP，真机联调不能用 127.0.0.1
  // 未配置/不可达时 PayView 自动降级为原生 Mock 收银台（不产生真实流水）
  static readonly PAY_GATEWAY_URL: string = "http://127.0.0.1:3001"
  static readonly SUCCESS_CODE: string = "1"
  static readonly USER_INFO_KEY: string = "user_info_key"
  static readonly SWITCH_TAB: string = "switch_tab"
  static readonly FORM_ID_LIST: string = "form_id_list"
  static readonly CARD_IMAGE_DATA: string = "card_image_data"
  // UIAbility context 的 AppStorage key，供 network 模块读取（避免循环依赖）
  static readonly ABILITY_CONTEXT_KEY: string = "ability_context"
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
