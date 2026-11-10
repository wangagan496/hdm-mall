import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { Database } from './database.ts'
import type { User } from './accounts.ts'
import { AppError, ensure } from './errors.ts'
import { recordStockMovement } from './inventory.ts'
import { systemClock, type Clock } from './clock.ts'
import { productAudit } from './audit.ts'

const specFields = z.object({ spec: z.string().trim().min(1).max(60), priceCents: z.number().int().min(1).max(100000000),
  stock: z.number().int().min(0).max(2147483647), enabled: z.boolean().default(true) }).strict()
export const productCreateSchema = z.object({ requestKey: z.string().uuid(), name: z.string().trim().min(1).max(100),
  categoryId: z.string().min(1).max(100), description: z.string().trim().max(2000).default(''), imageId: z.string().uuid().optional(),
  skus: z.array(specFields).min(1).max(50) }).strict()
type ProductCreate = z.infer<typeof productCreateSchema>
export const productEditSchema = z.object({ requestKey: z.string().uuid(), expectedRevision: z.number().int().positive().safe().optional(),
  name: productCreateSchema.shape.name.optional(), description: z.string().trim().max(2000).optional(),
  imageId: z.string().uuid().optional(), status: z.enum(['on', 'off']).optional(),
  skus: z.array(specFields.partial().extend({ enabled: z.boolean().optional(), id: z.string().min(1).max(100).optional(),
    expectedStock: specFields.shape.stock.optional() }).strict()).min(1).max(50).optional() }).strict()
type ProductEdit = z.infer<typeof productEditSchema>
interface ProductRow { id: string; name: string; category: string; description: string; picture: string; status: 'on' | 'off'; revision: number }
interface SkuRow { id: string; spec: string; price: number; stock: number; enabled: number }
interface SavedChange { request_body: string; result: string }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => JSON.stringify(key) + ':' + canonical(value)).join(',') + '}'
  return JSON.stringify(value)
}

export class Products {
  readonly db: Database
  readonly publicUrl: string
  readonly clock: Clock
  constructor(db: Database, publicUrl: string, clock: Clock = systemClock) {
    this.db = db; this.publicUrl = publicUrl; this.clock = clock
  }
  private merchant(user: User) { ensure(user.role === 'merchant', 403, '需要商家权限') }
  categories(user: User) {
    this.merchant(user)
    return this.db.all<{ id: string; name: string }>('SELECT id,name FROM categories WHERE parent_id IS NULL ORDER BY rowid')
  }
  uploadImage(user: User, requestKey: string, bytes: Buffer, uploadsPath: string) {
    this.merchant(user)
    ensure(bytes.length <= 512 * 1024, 413, '图片过大，请换一张')
    ensure(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff, 400, '仅支持JPEG商品图片')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    return this.db.transaction(() => {
      const existing = this.db.one<{ image_id: string; sha256: string; path: string }>('SELECT image_id,sha256,path FROM product_images WHERE actor_id=? AND request_key=?', user.id, requestKey)
      if (existing) {
        ensure(existing.sha256 === sha256, 409, '同一次上传不能更换图片')
        return { imageId: existing.image_id, picture: this.publicUrl + existing.path }
      }
      const imageId = randomUUID(), path = '/uploads/' + imageId + '.jpg'
      mkdirSync(uploadsPath, { recursive: true })
      // 文件完整落盘后才登记；数据库失败留下未引用文件，不会把半张图交给商品。
      writeFileSync(join(uploadsPath, imageId + '.jpg'), bytes, { flag: 'wx' })
      this.db.run('INSERT INTO product_images(image_id,actor_id,request_key,sha256,path,created) VALUES(?,?,?,?,?,?)',
        imageId, user.id, requestKey, sha256, path, this.clock.now())
      return { imageId, picture: this.publicUrl + path }
    })
  }
  list(user: User, page: number, pageSize: number, status?: 'on' | 'off') {
    this.merchant(user)
    const where = status ? 'WHERE status=?' : '', params = status ? [status] : []
    const counts = this.db.one<{ count: number }>(`SELECT COUNT(*) AS count FROM products ${where}`, ...params)!.count
    const items = this.db.all<{ id: string }>(`SELECT id FROM products ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize)
      .map(row => this.detail(user, row.id))
    return { items, counts, pages: Math.ceil(counts / pageSize), page, pageSize }
  }
  detail(user: User, id: string) {
    this.merchant(user)
    const row = this.db.one<ProductRow>('SELECT * FROM products WHERE id=?', id)
    ensure(row, 404, '商品不存在')
    const categoryId = this.db.one<{ id: string }>(`SELECT COALESCE(c.parent_id,c.id) AS id FROM product_categories pc
      JOIN categories c ON c.id=pc.category_id WHERE pc.product_id=?`, id)?.id || ''
    const imageId = this.db.one<{ image_id: string }>('SELECT image_id FROM product_images WHERE path=? AND product_id=?', row.picture, id)?.image_id || ''
    const skus = this.db.all<SkuRow>('SELECT id,spec,price,stock,enabled FROM skus WHERE product_id=? ORDER BY rowid', id)
      .map(sku => ({ id: sku.id, spec: sku.spec, priceCents: sku.price, stock: sku.stock, enabled: sku.enabled === 1 }))
    return { id, name: row.name, categoryId, categoryName: row.category, description: row.description,
      picture: this.publicUrl + row.picture, imageId, status: row.status, revision: row.revision, skus }
  }
  receipt(user: User, requestKey: string) {
    this.merchant(user)
    const row = this.db.one<SavedChange>('SELECT request_body,result FROM product_changes WHERE actor_id=? AND request_key=?', user.id, requestKey)
    ensure(row, 404, '尚未找到本次保存记录')
    return JSON.parse(row.result) as ReturnType<Products['detail']>
  }
  private replay(user: User, requestKey: string, body: string) {
    const row = this.db.one<SavedChange>('SELECT request_body,result FROM product_changes WHERE actor_id=? AND request_key=?', user.id, requestKey)
    if (!row) return undefined
    ensure(row.request_body === body, 409, '同一次保存不能修改内容，请确认原结果')
    return JSON.parse(row.result) as ReturnType<Products['detail']>
  }
  private image(user: User, imageId: string | undefined, productId: string) {
    if (!imageId) return '/assets/product.svg'
    const image = this.db.one<{ path: string; product_id: string | null }>('SELECT path,product_id FROM product_images WHERE image_id=? AND actor_id=?', imageId, user.id)
    ensure(image && (!image.product_id || image.product_id === productId), 400, '请选择已上传的商品图片')
    this.db.run('UPDATE product_images SET product_id=? WHERE image_id=?', productId, imageId)
    return image.path
  }
  private saveReceipt(user: User, requestKey: string, action: 'create' | 'edit', id: string, body: string) {
    const result = this.detail(user, id)
    this.db.run('INSERT INTO product_changes(actor_id,request_key,action,product_id,request_body,result,created) VALUES(?,?,?,?,?,?,?)',
      user.id, requestKey, action, id, body, JSON.stringify(result), this.clock.now())
    return result
  }
  create(user: User, data: ProductCreate) {
    this.merchant(user)
    const body = canonical({ action: 'create', ...data })
    return this.db.transaction(() => {
      const replay = this.replay(user, data.requestKey, body)
      if (replay) return replay
      const parent = this.db.one<{ id: string; name: string }>('SELECT id,name FROM categories WHERE id=? AND parent_id IS NULL', data.categoryId)
      ensure(parent, 400, '请选择已有一级分类')
      const names = data.skus.filter(sku => sku.enabled).map(sku => sku.spec)
      ensure(new Set(names).size === names.length, 400, '启用的规格名称不能重复')
      const id = randomUUID()
      this.db.run('INSERT INTO products(id,name,category,picture,description) VALUES(?,?,?,?,?)', id, data.name, parent.name, '/assets/product.svg', data.description)
      const picture = this.image(user, data.imageId, id)
      this.db.run('UPDATE products SET picture=? WHERE id=?', picture, id)
      const childKey = `child:${parent.name}:${data.name}`
      let child = this.db.one<{ id: string }>('SELECT id FROM categories WHERE source_key=?', childKey)
      if (!child) {
        child = { id: 'subcategory-' + randomUUID() }
        this.db.run('INSERT INTO categories(id,name,parent_id,source_key) VALUES(?,?,?,?)', child.id, data.name, parent.id, childKey)
      }
      this.db.run('INSERT INTO product_categories(product_id,category_id) VALUES(?,?)', id, child.id)
      for (const sku of data.skus) {
        const skuId = randomUUID()
        this.db.run('INSERT INTO skus(id,product_id,spec,price,stock,enabled) VALUES(?,?,?,?,?,?)', skuId, id, sku.spec, sku.priceCents, sku.stock, Number(sku.enabled))
        recordStockMovement(this.db, { kind: 'opening', skuId, delta: sku.stock }, this.clock)
      }
      const result = this.saveReceipt(user, data.requestKey, 'create', id, body)
      productAudit(this.db,user,id,data.requestKey,this.clock.now(),undefined,result)
      return result
    })
  }
  edit(user: User, id: string, data: ProductEdit) {
    this.merchant(user)
    const body = canonical({ action: 'edit', productId: id, ...data })
    return this.db.transaction(() => {
      const replay = this.replay(user, data.requestKey, body)
      if (replay) return replay
      const current = this.detail(user, id)
      const statusOnly = data.status !== undefined && data.name === undefined && data.description === undefined && data.imageId === undefined && data.skus === undefined
      ensure(statusOnly || data.expectedRevision !== undefined, 400, '请先读取商品再保存')
      if (!statusOnly && current.revision !== data.expectedRevision) throw new AppError(409,
        '该商品刚被修改，请核对最新内容', 'PRODUCT_REVISION_CHANGED', current)
      const updated = current.skus.map(sku => ({ ...sku }))
      const seen = new Set<string>()
      for (const patch of data.skus || []) {
        if (patch.id) {
          ensure(!seen.has(patch.id), 400, '同一规格不能重复提交'); seen.add(patch.id)
          const sku = updated.find(sku => sku.id === patch.id)
          ensure(sku, 400, '规格不属于此商品')
          ensure(patch.stock === undefined || patch.expectedStock !== undefined, 400, '修改库存时请提供载入库存')
          ensure(patch.stock !== undefined || patch.expectedStock === undefined, 400, '库存比较值必须与库存同时提交')
          if (patch.stock !== undefined && sku.stock !== patch.expectedStock) throw new AppError(409,
            '库存刚有变化，请核对当前库存后再保存', 'PRODUCT_STOCK_CHANGED', current)
          const { expectedStock: _expectedStock, ...fields } = patch
          Object.assign(sku, fields)
        } else {
          const { id: _id, ...fields } = patch
          updated.push({ id: randomUUID(), ...specFields.parse(fields) })
        }
      }
      ensure(updated.length <= 50, 400, '每件商品最多50个规格')
      const names = updated.filter(sku => sku.enabled).map(sku => sku.spec)
      ensure(new Set(names).size === names.length, 400, '启用的规格名称不能重复')
      // 先释放变更中的规格名，支持同一次保存交换名称或停用后复用名称。
      for (const sku of updated) {
        const previous = current.skus.find(value => value.id === sku.id)
        if (previous?.enabled && (!sku.enabled || previous.spec !== sku.spec)) this.db.run('UPDATE skus SET enabled=0 WHERE id=?', sku.id)
      }
      for (const sku of updated) {
        const previous = current.skus.find(value => value.id === sku.id)
        if (!previous) {
          this.db.run('INSERT INTO skus(id,product_id,spec,price,stock,enabled) VALUES(?,?,?,?,?,?)', sku.id, id, sku.spec, sku.priceCents, sku.stock, Number(sku.enabled))
          recordStockMovement(this.db, { kind: 'opening', skuId: sku.id, delta: sku.stock }, this.clock)
          continue
        }
        if (sku.stock !== previous.stock) {
          const balance = this.db.one<{ total: number }>('SELECT COALESCE(SUM(delta),0) AS total FROM inventory_movements WHERE sku_id=?', sku.id)!.total
          ensure(balance === previous.stock, 409, '库存与流水存在差异，请核查记录')
        }
        this.db.run('UPDATE skus SET spec=?,price=?,stock=?,enabled=? WHERE id=?', sku.spec, sku.priceCents, sku.stock, Number(sku.enabled), sku.id)
        if (sku.stock !== previous.stock) this.db.run(`INSERT INTO inventory_movements(sku_id,actor_id,kind,delta,balance,business_key,created,reason)
          VALUES(?,?,'adjust',?,?,?,?,?)`, sku.id, user.id, sku.stock - previous.stock, sku.stock,
          `product-edit:${user.id}:${data.requestKey}:${sku.id}`, this.clock.now(), '商品编辑调整')
      }
      const picture = data.imageId === undefined ? this.db.one<ProductRow>('SELECT * FROM products WHERE id=?', id)!.picture : this.image(user, data.imageId, id)
      this.db.run('UPDATE products SET name=?,description=?,picture=?,status=? WHERE id=?', data.name ?? current.name,
        data.description ?? current.description, picture, data.status ?? current.status, id)
      const result = this.saveReceipt(user, data.requestKey, 'edit', id, body)
      productAudit(this.db,user,id,data.requestKey,this.clock.now(),current,result)
      return result
    })
  }
}
