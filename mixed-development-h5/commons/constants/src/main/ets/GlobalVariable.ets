import BuildProfile from 'BuildProfile'

export class GlobalVariable {
  static readonly BREAK_POINT_KEY: string = "break_point"
  static readonly SAFE_AREA_TOP: string = "safe_area_top"
  static readonly SAFE_AREA_BOTTOM: string = "safe_area_bottom"
  // 构建时校验并注入，运行时不回退到本机地址。
  static readonly APP_ENV: string = BuildProfile.APP_ENV
  static readonly BASE_URL: string = BuildProfile.API_BASE_URL
  static readonly DECISION_SERVICE_URL: string = BuildProfile.DECISION_SERVICE_URL
  static readonly SUCCESS_CODE: string = "1"
  static readonly USER_INFO_KEY: string = "user_info_key"
  static readonly APP_FOREGROUND_SEQUENCE: string = "app_foreground_sequence"
  static readonly SWITCH_TAB: string = "switch_tab"
  static readonly FORM_ID_LIST: string = "form_id_list"
  static readonly CARD_IMAGE_DATA: string = "card_image_data"
  // UIAbility context 的 AppStorage key，供 network 模块读取（避免循环依赖）
  static readonly ABILITY_CONTEXT_KEY: string = "ability_context"
  /**
   * 演示订单流程开关。
   * 当前自营后端负责订单状态，默认关闭旧本地演示覆盖层。
   * 仅 development 调试构建可显式开启；test、production 和 release 构建禁止开启。
   */
  static readonly DEMO_ORDER_FLOW: boolean = BuildProfile.DEMO_ORDER_FLOW
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
