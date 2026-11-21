import type { DatabaseSync } from 'node:sqlite'

export function inspectDisputes(db:DatabaseSync){
  for(const d of db.prepare(`SELECT d.*,o.owner_id,e.order_id FROM review_disputes d JOIN evaluations e ON e.public_id=d.review_id
    JOIN orders o ON o.id=e.order_id`).iterate()){
    if(db.prepare(`SELECT 1 FROM order_items i WHERE i.order_id=? AND NOT EXISTS(SELECT 1 FROM product_changes c WHERE
      c.product_id=i.product_id AND c.actor_id=? AND c.action='create')`).get(d.order_id!,d.merchant_id!)) throw Error('登记商家归属无效')
    const images=JSON.parse(String(d.images)) as string[]
    if(images.some(p=>!db.prepare('SELECT 1 FROM product_images WHERE actor_id=? AND path=?').get(d.merchant_id!,p))) throw Error('登记图片归属无效')
    let status='',concluded=false
    for(const a of db.prepare(`SELECT a.*,c.kind outcome,c.reason explanation FROM review_dispute_actions a LEFT JOIN review_dispute_conclusions c
      ON c.action_id=a.id WHERE a.review_id=? ORDER BY a.id`).iterate(d.review_id!)){
      const independent=a.actor_id!==d.merchant_id && a.actor_id!==d.owner_id
      if((a.kind==='conclude')!==!!a.outcome) throw Error('复核结论记录无效')
      if(a.kind==='register' && !status && a.actor_id===d.merchant_id && a.reason===d.reason) status='registered'
      else if(a.kind==='accept' && independent && ['registered','correction-requested'].includes(status)) status='under-review'
      else if(a.kind==='conclude' && independent && status==='under-review' && a.reason===a.explanation){status='concluded'; concluded=true}
      else if(concluded && ((a.kind==='buyer-correction' && a.actor_id===d.owner_id)||(a.kind==='merchant-correction' && a.actor_id===d.merchant_id))) status='correction-requested'
      else throw Error('复核动作与历史不一致')
    }
    if(status!==d.status) throw Error('复核状态与历史不一致')
  }
}
