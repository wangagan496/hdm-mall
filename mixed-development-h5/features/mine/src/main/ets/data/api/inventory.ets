export interface InventoryReturnRecord {
  afterSaleId: string; orderId: string; skuId: string; count: number; restockCount: number
  buyerAccount: string; createdAt: number; sequence: number
  pendingInspectionCount: number; rejectedCount: number
}
export interface InventoryItem {
  skuId: string
  name: string
  spec: string
  stock: number
  recordedStock: number
  difference: number
  pendingInspectionCount?: number
  rejectedReturnCount?: number
  hiddenRejectedRecordCount?: number
  returnRecords?: InventoryReturnRecord[]
}
export interface InventoryPage { items: InventoryItem[]; counts: number; pages: number; page: number; pageSize: number }
export interface StockAdjustmentDraft { requestKey: string; skuId: string; delta: number; expectedStock: number; reason: string }
export interface StockAdjustmentReceipt { id: number; skuId: string; delta: number; balance: number; reason: string; createdAt: number }
