import type { DatabaseSync } from 'node:sqlite'
import { removePromotionShippingSchema } from './legacy-v15.ts'
export function removeReturnPolicySchema(db:DatabaseSync){
 removePromotionShippingSchema(db)
 if(!db.prepare('PRAGMA table_info(products)').all().some(r=>r.name==='return_policy'))return
 db.exec('DROP TRIGGER IF EXISTS products_return_policy_revision')
 db.exec('ALTER TABLE after_sale_items DROP COLUMN condition_declared')
 db.exec('ALTER TABLE order_items DROP COLUMN return_policy_confirmed')
 for(const table of ['products','order_items'])for(const column of ['return_policy_note','return_policy_reason','return_policy'])db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
 db.exec('PRAGMA user_version=14')
}
