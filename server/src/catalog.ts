import { Database } from './database.ts'
import { ensure } from './errors.ts'
import type { User } from './accounts.ts'

export interface Sku { id: string; product_id: string; spec: string; price: number; stock: number; name: string; picture: string }
export class Catalog {
  db: Database
  publicUrl: string
  constructor(db: Database, publicUrl: string) { this.db = db; this.publicUrl = publicUrl }
  seed() {
    this.db.transaction(() => {
      for (const [index, name, category, price] of [[1, '纯棉短袜', '服饰', 1900], [2, '轻便双肩包', '箱包', 9900], [3, '收纳包', '箱包', 2900], [4, '日常休闲鞋', '鞋靴', 15900]] as const) {
        const id = `hdm-${index}`
        this.db.run('INSERT OR IGNORE INTO products VALUES(?,?,?,?,?)', id, name, category, '/assets/product.svg', '自营商品 · 服务端统一库存')
        this.db.run('INSERT OR IGNORE INTO skus VALUES(?,?,?,?,?)', `${id}-a`, id, '标准款', price, 20)
        this.db.run('INSERT OR IGNORE INTO skus VALUES(?,?,?,?,?)', `${id}-b`, id, '加大款', price + 500, 10)
      }
    })
  }
  sku(id: string): Sku {
    const row = this.db.one<Sku>('SELECT s.*,p.name,p.picture FROM skus s JOIN products p ON p.id=s.product_id WHERE s.id=?', id)
    ensure(row, 404, '商品规格不存在')
    return { ...row, picture: this.publicUrl + row.picture }
  }
  list(keyword = '') {
    return this.db.all<{ id: string; name: string; picture: string; description: string; price: number; stock: number; category: string }>(
      'SELECT p.*,MIN(CASE WHEN s.stock>0 THEN s.price END) AS price,SUM(s.stock) AS stock FROM products p JOIN skus s ON s.product_id=p.id GROUP BY p.id HAVING SUM(s.stock)>0')
      .filter(p => p.name.includes(keyword) || p.category.includes(keyword))
      .map(p => ({ id: p.id, name: p.name, picture: this.publicUrl + p.picture, desc: p.description, price: p.price / 100, originalPrice: p.price / 100, orderNum: 0 }))
  }
  detail(id: string) {
    const product = this.db.one<{ id: string; name: string; picture: string; description: string }>('SELECT * FROM products WHERE id=?', id)
    ensure(product, 404, '商品不存在')
    const skus = this.db.all<Sku>('SELECT * FROM skus WHERE product_id=?', id)
    const picture = this.publicUrl + product.picture
    const inventory = skus.reduce((total, s) => total + s.stock, 0)
    return { id, name: product.name, desc: product.description, picture, price: Math.min(...skus.map(s => s.price)) / 100, orderNum: 0, inventory,
      mainPictures: [picture], details: { pictures: [picture], properties: [{ name: '说明', value: product.description }] },
      specs: [{ name: '规格', values: skus.map(s => ({ name: s.spec, picture, selected: false, disabled: s.stock === 0 })) }],
      skus: skus.map(s => ({ id: s.id, skuCode: s.id, price: String(s.price / 100), oldPrice: String(s.price / 100), inventory: s.stock, picture, specsText: s.spec, specs: [{ name: '规格', valueName: s.spec }] })) }
  }
  categories() {
    return this.db.all<{ category: string }>('SELECT DISTINCT category FROM products').map((c, i) => {
      const goods = this.list(c.category)
      return { id: `category-${i}`, name: c.category, picture: goods[0]?.picture ?? '', goods,
        children: [{ id: `category-${i}-all`, name: c.category, picture: goods[0]?.picture ?? '', goods }] }
    }).filter(c => c.goods.length)
  }
  cart(user: User) {
    return this.db.all<{ sku_id: string; count: number; selected: number }>('SELECT * FROM carts WHERE user_id=?', user.id).map(row => {
      const s = this.sku(row.sku_id)
      return { id: s.product_id, skuId: s.id, name: s.name, picture: s.picture, price: s.price / 100, stock: s.stock, attrsText: s.spec, count: row.count, selected: !!row.selected }
    })
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
    } else {
      const current = this.db.one<{ count: number; selected: number }>('SELECT * FROM carts WHERE user_id=? AND sku_id=?', user.id, skuId)
      ensure(current, 404, '购物车商品不存在')
      if (data.count !== undefined) ensure(data.count <= this.sku(skuId).stock, 409, '该规格库存不足或已售罄')
      this.db.run('UPDATE carts SET count=?,selected=? WHERE user_id=? AND sku_id=?', data.count ?? current.count, data.selected === undefined ? current.selected : Number(data.selected), user.id, skuId)
    }
    return this.cart(user).find(row => row.skuId === skuId) ?? null
  }
}
