import type { Database } from './database.ts'
import { evaluationItems } from './evaluations.ts'

interface Query {page:number;pageSize:number;skuId?:string;templateVersion?:string}
interface Row {
  buyer_contact:string|null; buyer_account:string; nickname:string; status:string; order_id:string; public_id:string; content:string; created:number; score:number; logistics_score:number|null;
  service_score:number|null; service_occurred:number; received_at:number|null; received_by:string|null; signed_at:number|null; reply:string|null
}
export function evaluationPage(db: Database, product: string, query: Query, merchant=false) {
  // Each page counts orders once, even when a buyer purchased several matching SKUs.
  const skuId = query.skuId ?? (merchant ? undefined : db.one<{id:string}>(
    'SELECT id FROM skus WHERE product_id=? AND enabled=1 ORDER BY id LIMIT 1',product)?.id ?? '')
  const bindings = [product]
  let scope = 'i.product_id=?'
  if (skuId !== undefined) { scope+=' AND i.sku_id=?'; bindings.push(skuId) }
  if (!merchant) {
    scope += ` AND p.status='on' AND i.review_edition=p.review_edition AND COALESCE(s.receipt_id,'')=COALESCE(
      (SELECT receipt_id FROM promise_publications WHERE product_id=i.product_id ORDER BY rowid DESC LIMIT 1),'')`
  }
  if (query.templateVersion !== undefined) {
    scope += " AND COALESCE(json_extract(s.snapshot,'$.templateVersion'),'')=?"
    bindings.push(query.templateVersion)
  }
  const from = `FROM evaluations e JOIN orders o ON o.id=e.order_id JOIN users u ON u.id=o.owner_id
    WHERE NOT EXISTS(SELECT 1 FROM review_moderation m WHERE m.order_id=e.order_id)
    AND EXISTS(SELECT 1 FROM order_items i JOIN products p ON p.id=i.product_id
    LEFT JOIN order_item_promise_snapshots s ON s.order_id=i.order_id AND s.sku_id=i.sku_id
    WHERE i.order_id=e.order_id AND ${scope})`
  const summary = db.one<{counts:number;neutral:number;negative:number;product:number|null;logistics:number|null;service:number|null}>(
    `SELECT count(*) counts,count(CASE WHEN e.score=3 THEN 1 END) neutral,count(CASE WHEN e.score<3 THEN 1 END) negative,
    avg(e.score) product,avg(e.logistics_score) logistics,avg(e.service_score) service ${from}`,...bindings)!
  const offset = (query.page-1)*query.pageSize
  const rows = offset>=summary.counts ? [] : db.all<Row>(`SELECT e.*,u.nickname,u.status,u.account buyer_account,json_extract(o.address,'$.contact') buyer_contact,o.received_at,o.received_by,o.signed_at,
    (SELECT content FROM merchant_evaluation_replies r WHERE r.order_id=e.order_id) reply ${from}
    ORDER BY e.created DESC,e.order_id LIMIT ? OFFSET ?`,...bindings,query.pageSize,offset)
  const items = rows.map(row=>{
    const safeText = (value:string) => {
      let masked=value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱已隐藏]')
        .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9](?:[- ]?\d){9}(?!\d)/g,'[电话已隐藏]')
      for(const privateValue of [row.buyer_contact,row.buyer_account]){
        if(privateValue && privateValue.length>=3) masked=masked.replaceAll(privateValue,'[已隐藏]')
      }
      return masked
    }
    const fields = evaluationItems(db,row.order_id,skuId).filter(field=>db.one(
      `SELECT 1 FROM order_items i JOIN products p ON p.id=i.product_id LEFT JOIN order_item_promise_snapshots s
       ON s.order_id=i.order_id AND s.sku_id=i.sku_id WHERE i.order_id=? AND i.sku_id=? AND ${scope}`,row.order_id,field.skuId,...bindings)).map(field=>({...field,note:safeText(field.note),quote:safeText(field.quote),value:field.value && safeText(field.value)}))
    const badges:string[]=[]
    const receipt = row.received_at !== null && (!!row.received_by || !!row.signed_at)
    if(receipt) badges.push('已真实收货')
    if(receipt && fields.length && fields.every(f=>f.quote && f.templateVersion)) badges.push('对照承诺逐条打分')
    const name = Array.from(row.nickname)
    const nickname = row.status==='deleted' ? '已注销用户' : (name[0]??'')+'***'+(name.length>2 ? name.at(-1) : '')
    return { id:row.public_id,score:row.score,productScore:row.score,logisticsScore:row.logistics_score,
      serviceScore:row.service_score,serviceOccurred:!!row.service_occurred,content:safeText(row.content),createTime:new Date(row.created).toISOString(),
      member:{nickname},pictures:[],items:fields,badges,receiptBasis:receipt ? (row.signed_at?'订单签收':'买家确认收货') : null,reply:row.reply && safeText(row.reply) }
  })
  return {items,counts:summary.counts,pages:Math.ceil(summary.counts/query.pageSize),page:query.page,pageSize:query.pageSize,summary}
}
