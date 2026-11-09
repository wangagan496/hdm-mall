export interface ProductSku { id?: string; spec: string; priceCents: number; stock: number; enabled: boolean }
export interface ProductSkuPatch { id?: string; spec?: string; priceCents?: number; stock?: number; enabled?: boolean; expectedStock?: number }
export interface ProductData {
  id: string; name: string; categoryId: string; categoryName: string; description: string;
  picture: string; imageId: string; status: string; revision: number; skus: ProductSku[]
}
export interface ProductBody {
  requestKey?: string; expectedRevision?: number; name?: string; categoryId?: string;
  description?: string; imageId?: string; status?: string; skus?: ProductSkuPatch[]
}
export interface ProductPending { productId: string; body: ProductBody; image: string; imageKey: string }
export interface ProductPage { items: ProductData[]; page: number; pages: number; counts: number }
export interface ProductCategory { id: string; name: string }
export interface ProductImageResult { imageId: string; picture: string }
export interface ProductErrorBody { reason?: string; result?: ProductData }
export interface ProductErrorResponse { status: number; data?: ProductErrorBody }
export interface ProductError extends Error { httpStatus?: number; response?: ProductErrorResponse }
export interface ProductSkuInput { id?: string; spec: string; price: string; stock: string; enabled: boolean; originalPrice: number }
export interface ProductDraft {
  name: string; categoryId: string; description: string; image: string; picture: string; imageId: string;
  status: string; revision: number; skus: ProductSkuInput[]
  base?: ProductData
}
export interface ProductNotice {
  text: string
  kind: 'normal' | 'warning'
}
