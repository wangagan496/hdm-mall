import { Database } from './database.ts'
import { systemClock, type Clock } from './clock.ts'
import { ensure } from './errors.ts'
import type { User } from './accounts.ts'
import { randomUUID } from 'node:crypto'
import { recordStockMovement } from './inventory.ts'

export interface Sku { id: string; product_id: string; spec: string; price: number; stock: number; name: string; picture: string }
interface ProductSummary { id: string; name: string; picture: string; description: string; price: number }
export class Catalog {
  db: Database
  publicUrl: string
  readonly clock: Clock
  constructor(db: Database, publicUrl: string, clock: Clock = systemClock) { this.db = db; this.publicUrl = publicUrl; this.clock = clock }
  seed() {
    this.db.transaction(() => {
      for (const [index, name, category, price] of [[1, '纯棉短袜', '服饰', 1900], [2, '轻便双肩包', '箱包', 9900], [3, '收纳包', '箱包', 2900], [4, '日常休闲鞋', '鞋靴', 15900]] as const) {
        const id = `hdm-${index}`
        this.db.run('INSERT OR IGNORE INTO products VALUES(?,?,?,?,?)', id, name, category, '/assets/product.svg', '自营商品 · 服务端统一库存')
        for (const [suffix, spec, amount, stock] of [['a', '标准款', price, 20], ['b', '加大款', price + 500, 10]] as const) {
          const skuId = `${id}-${suffix}`
          const inserted = this.db.run('INSERT OR IGNORE INTO skus VALUES(?,?,?,?,?)', skuId, id, spec, amount, stock)
          if (inserted.changes === 1) recordStockMovement(this.db, { kind: 'opening', skuId, delta: stock }, this.clock)
        }
      }
      // 编号写入数据库后保持不变；改名、重排不再改变分类身份。
      const products = this.db.all<{ id: string; name: string; category: string }>('SELECT id,name,category FROM products ORDER BY rowid')
      for (const product of products) {
        if (this.db.one('SELECT product_id FROM product_categories WHERE product_id=?', product.id)) continue
        const parentKey = `parent:${product.category}`
        let parent = this.db.one<{ id: string }>('SELECT id FROM categories WHERE source_key=?', parentKey)
        if (!parent) {
          const count = this.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM categories WHERE parent_id IS NULL')!.count
          parent = { id: `category-${count}` }
          this.db.run('INSERT INTO categories VALUES(?,?,NULL,?)', parent.id, product.category, parentKey)
        }
        const childKey = `child:${product.category}:${product.name}`
        let child = this.db.one<{ id: string }>('SELECT id FROM categories WHERE source_key=?', childKey)
        if (!child) {
          child = { id: `subcategory-${randomUUID()}` }
          this.db.run('INSERT INTO categories VALUES(?,?,?,?)', child.id, product.name, parent.id, childKey)
        }
        this.db.run('INSERT INTO product_categories VALUES(?,?)', product.id, child.id)
      }
    })
  }
  sku(id: string): Sku {
    const row = this.db.one<Sku>('SELECT s.*,p.name,p.picture FROM skus s JOIN products p ON p.id=s.product_id WHERE s.id=?', id)
    ensure(row, 404, '商品规格不存在')
    return { ...row, picture: this.publicUrl + row.picture }
  }
  private productQuery(keyword: string, categoryId: string) {
    if (categoryId) ensure(this.db.one('SELECT id FROM categories WHERE id=?', categoryId), 400, '分类不存在，请重新选择')
    const params = [keyword, keyword]
    // instr 保留原 includes 的大小写与字面量语义，百分号和下划线不是通配符。
    let from = `FROM products p JOIN skus s ON s.product_id=p.id
      WHERE s.stock>0 AND (instr(p.name,?)>0 OR instr(p.category,?)>0)`
    if (categoryId) {
      from += ` AND EXISTS(SELECT 1 FROM product_categories pc JOIN categories c ON c.id=pc.category_id
        WHERE pc.product_id=p.id AND (c.id=? OR c.parent_id=?))`
      params.push(categoryId, categoryId)
    }
    return { from: from + ' GROUP BY p.id', params }
  }
  private productOrder(sortField: string, sortMethod: string) {
    const direction = sortMethod === 'asc' ? 'ASC' : 'DESC'
    // 编号按 Unicode 码点固定排序，与原生临时排序一致，不受系统语言影响。
    if (sortField === 'price') return `price ${direction},p.id COLLATE BINARY ASC`
    if (sortField === 'orderNum') return 'p.id COLLATE BINARY ASC' // 当前销量均为 0，沿用编号升序兜底。
    return `p.id COLLATE BINARY ${direction}` // 当前 publishTime 仍沿用编号排序。
  }
  private presentProduct(p: ProductSummary) {
    return { id: p.id, name: p.name, picture: this.publicUrl + p.picture, desc: p.description, price: p.price / 100, originalPrice: p.price / 100, orderNum: 0 }
  }
  list(keyword = '', categoryId = '', sortField = 'publishTime', sortMethod = 'desc') {
    const query = this.productQuery(keyword, categoryId)
    return this.db.all<ProductSummary>(`SELECT p.id,p.name,p.picture,p.description,MIN(s.price) AS price ${query.from}
      ORDER BY ${this.productOrder(sortField, sortMethod)}`, ...query.params).map(p => this.presentProduct(p))
  }
  listPage(page: number, pageSize: number, keyword = '', categoryId = '', sortField = 'publishTime', sortMethod = 'desc') {
    const query = this.productQuery(keyword, categoryId)
    const counts = this.db.one<{ count: number }>(`SELECT COUNT(*) AS count FROM (SELECT p.id ${query.from})`, ...query.params)!.count
    const offset = (page - 1) * pageSize
    const rows = offset >= counts ? [] : this.db.all<ProductSummary>(
      `SELECT p.id,p.name,p.picture,p.description,MIN(s.price) AS price ${query.from}
        ORDER BY ${this.productOrder(sortField, sortMethod)} LIMIT ? OFFSET ?`, ...query.params, pageSize, offset)
    return { items: rows.map(p => this.presentProduct(p)), counts, pages: Math.ceil(counts / pageSize), page, pageSize }
  }
  detail(id: string) {
    const product = this.db.one<{ id: string; name: string; picture: string; description: string }>('SELECT * FROM products WHERE id=?', id)
    ensure(product, 404, '商品不存在')
    const skus = this.db.all<Sku>('SELECT * FROM skus WHERE product_id=?', id)
    const picture = this.publicUrl + product.picture
    const inventory = skus.reduce((total, s) => total + s.stock, 0)
    const available = skus.filter(s => s.stock > 0)
    const price = Math.min(...(available.length ? available : skus).map(s => s.price)) / 100
    return { id, name: product.name, desc: product.description, picture, price, orderNum: 0, inventory,
      mainPictures: [picture], details: { pictures: [picture], properties: [{ name: '说明', value: product.description }] },
      specs: [{ name: '规格', values: skus.map(s => ({ name: s.spec, picture, selected: false, disabled: s.stock === 0 })) }],
      skus: skus.map(s => ({ id: s.id, skuCode: s.id, price: String(s.price / 100), oldPrice: String(s.price / 100), inventory: s.stock, picture, specsText: s.spec, specs: [{ name: '规格', valueName: s.spec }] })) }
  }
  categorySummary() {
    // 分类入口只需要名称与封面，不把每个分类的全部商品带到客户端。
    const rows = this.db.all<{ id: string; name: string; parent_id: string | null; picture: string | null }>(`
      SELECT c.id,c.name,c.parent_id,(SELECT p.picture FROM product_categories pc
        JOIN categories child ON child.id=pc.category_id JOIN products p ON p.id=pc.product_id
        WHERE (child.id=c.id OR child.parent_id=c.id)
          AND EXISTS(SELECT 1 FROM skus s WHERE s.product_id=p.id AND s.stock>0)
        ORDER BY p.id COLLATE BINARY DESC LIMIT 1) AS picture
      FROM categories c ORDER BY c.rowid`)
    const children = new Map<string, { id: string; name: string; picture: string }[]>()
    for (const row of rows) {
      if (!row.parent_id || row.picture === null) continue
      const items = children.get(row.parent_id) ?? []
      items.push({ id: row.id, name: row.name, picture: this.publicUrl + row.picture })
      children.set(row.parent_id, items)
    }
    return rows.filter(row => !row.parent_id && children.has(row.id)).map(row => ({
      id: row.id, name: row.name, picture: row.picture === null ? '' : this.publicUrl + row.picture,
      children: children.get(row.id)!,
    }))
  }
  categories() {
    const rows = this.db.all<{ id: string; name: string; parent_id: string | null }>('SELECT id,name,parent_id FROM categories ORDER BY rowid')
    return rows.filter(row => !row.parent_id).map(parent => {
      const goods = this.list('', parent.id)
      return { id: parent.id, name: parent.name, picture: goods[0]?.picture ?? '', goods,
        children: rows.filter(child => child.parent_id === parent.id).map(child => {
          const goods = this.list('', child.id)
          return { id: child.id, name: child.name, picture: goods[0]?.picture ?? '', goods }
        }) }
    })
  }
  cart(user: User, skuId?: string) {
    const rows = this.db.all<{ sku_id: string; count: number; selected: number; product_id: string; spec: string; price: number; stock: number; name: string; picture: string }>(
      `SELECT c.sku_id,c.count,c.selected,s.product_id,s.spec,s.price,s.stock,p.name,p.picture
       FROM carts c JOIN skus s ON s.id=c.sku_id JOIN products p ON p.id=s.product_id
       WHERE c.user_id=?${skuId === undefined ? '' : ' AND c.sku_id=?'} ORDER BY c.rowid`,
      ...(skuId === undefined ? [user.id] : [user.id, skuId]))
    return rows.map(row => ({ id: row.product_id, skuId: row.sku_id, name: row.name, picture: this.publicUrl + row.picture,
      price: row.price / 100, stock: row.stock, attrsText: row.spec, count: row.count, selected: !!row.selected }))
  }
  cartCount(user: User) {
    // 角标统计件数，包含未勾选及售罄条目，无需读取商品资料。
    return this.db.one<{ count: number }>('SELECT COALESCE(SUM(count),0) AS count FROM carts WHERE user_id=?', user.id)!.count
  }
  addCart(user: User, skuId: string, count: number) {
    const sku = this.sku(skuId)
    const previous = this.db.one<{ count: number }>('SELECT count FROM carts WHERE user_id=? AND sku_id=?', user.id, skuId)?.count ?? 0
    ensure(sku.stock >= previous + count, 409, '该规格库存不足或已售罄')
    this.db.run('INSERT INTO carts VALUES(?,?,?,1) ON CONFLICT(user_id,sku_id) DO UPDATE SET count=excluded.count,selected=1', user.id, skuId, previous + count)
    return { count: previous + count }
  }
  updateCart(user: User, skuId: string, data: { count?: number; selected?: boolean }) {
    if (skuId === 'selected') {
      ensure(data.selected !== undefined, 400, '缺少勾选状态')
      this.db.run('UPDATE carts SET selected=? WHERE user_id=?', data.selected ? 1 : 0, user.id)
      return null
    } else {
      const current = this.db.one<{ count: number; selected: number }>('SELECT * FROM carts WHERE user_id=? AND sku_id=?', user.id, skuId)
      ensure(current, 404, '购物车商品不存在')
      if (data.count !== undefined) ensure(data.count <= this.sku(skuId).stock, 409, '该规格库存不足或已售罄')
      this.db.run('UPDATE carts SET count=?,selected=? WHERE user_id=? AND sku_id=?', data.count ?? current.count, data.selected === undefined ? current.selected : Number(data.selected), user.id, skuId)
    }
    return this.cart(user, skuId)[0] ?? null
  }
}
