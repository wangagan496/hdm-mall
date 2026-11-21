// Each entry points to a current route or control from baseline/entry-points.json.
export const identityEntries = {
  buyer: [
    { id: 'home-search', label: '首页搜索', locked: false },
    { id: 'home-banner', label: '首页轮播商品', locked: false },
    { id: 'home-categories', label: '首页商品分类', locked: false },
    { id: 'buyer-orders', label: '我的订单', locked: true },
    { id: 'buyer-family', label: '亲友中心', locked: true },
    { id: 'favorites', label: '我的收藏', locked: false },
    { id: 'history', label: '我的足迹', locked: false },
    { id: 'buyer-service', label: '我的客服', locked: true }
  ],
  merchant: [
    { id: 'merchant-orders', label: '店铺订单', locked: true },
    { id: 'merchant-after-sales', label: '售后管理', locked: true },
    { id: 'merchant-service', label: '客服留言', locked: true },
    { id: 'merchant-products', label: '商品管理', locked: false },
    { id: 'merchant-inventory', label: '库存管理', locked: false },
    { id: 'merchant-promotions', label: '满减设置', locked: false },
    { id: 'merchant-reconciliation', label: '对账', locked: false },
    { id: 'merchant-audit', label: '操作记录', locked: false }
  ]
}
