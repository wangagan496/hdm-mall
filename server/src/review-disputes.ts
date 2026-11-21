import { z } from 'zod'
import type { User } from './accounts.ts'
import type { Database } from './database.ts'
import { ensure } from './errors.ts'
import { evaluationItems } from './evaluations.ts'
import { checkPublicContent } from './content-filter.ts'

const reasonField=z.string().trim().refine(s=>Array.from(s).length>=5 && Array.from(s).length<=200,'请填写5至200字理由')
const kinds=z.enum(['maintain','hide','correct'])
interface Review { order_id:string; owner_id:string; content:string; score:number; address:string; account:string }
function review(db:Database,id:string){
  const row=db.one<Review>(`SELECT e.order_id,o.owner_id,e.content,e.score,o.address,u.account FROM evaluations e
    JOIN orders o ON o.id=e.order_id JOIN users u ON u.id=o.owner_id WHERE e.public_id=?`,id)
  ensure(row,404,'评价不存在')
  return row
}
export function ownsReview(db:Database,order:string,merchant:string){
  // The evaluation covers the whole order. Every item must have a documented creator.
  const counts=db.one<{total:number;owned:number}>(`SELECT count(*) total,sum(EXISTS(SELECT 1 FROM product_changes c
    WHERE c.product_id=i.product_id AND c.action='create' AND c.actor_id=?)) owned FROM order_items i WHERE order_id=?`,merchant,order)!
  return counts.total>0 && counts.total===counts.owned
}
export function reviewer(user:User){
  return (process.env.REVIEW_REVIEWER_ACCOUNTS??'').split(',').some(account=>account.trim()===user.account)
}
function redact(value:string,row:Review,extra:string[]=[]){
  const a=JSON.parse(row.address)
  let result=value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱已隐藏]').replace(/(?:\+?86[- ]?)?1[3-9](?:[- ]?\d){9}/g,'[电话已隐藏]')
  for(const s of [row.order_id,row.owner_id,row.account,a.receiver,a.contact,a.address,a.fullLocation,a.countyCode,...String(a.fullLocation??'').split(/\s+/),...extra]){
    if(typeof s==='string' && s) result=result.replaceAll(s,'[已隐藏]')
  }
  return result
}
function original(db:Database,row:Review){
  return {content:row.content,score:row.score,items:evaluationItems(db,row.order_id).map(({skuId, ...field})=>field)}
}
function record(db:Database,id:string,kind:string,user:User,reason:string,now:number,row:Review){
  return db.run('INSERT INTO review_dispute_actions(review_id,kind,actor_id,reason,created,original) VALUES(?,?,?,?,?,?)',
    id,kind,user.id,reason,now,JSON.stringify(original(db,row))).lastInsertRowid
}
function dispute(db:Database,id:string){
  return db.one<{merchant_id:string;status:string;reason:string;images:string}>('SELECT * FROM review_disputes WHERE review_id=?',id)
}
export function partyDispute(db:Database,id:string,party:'buyer'|'merchant',merchant?:string){
  const d=dispute(db,id)
  if(!d || (party==='merchant' && merchant!==d.merchant_id)) return null
  const conclusion=db.one<{kind:string;reason:string;time:number}>(`SELECT c.kind,c.reason,a.created time FROM review_dispute_conclusions c
    JOIN review_dispute_actions a ON a.id=c.action_id WHERE a.review_id=? ORDER BY a.id DESC LIMIT 1`,id)
  if(party==='buyer' && !conclusion) return null
  const timeline=db.all<{kind:string;time:number}>('SELECT kind,created time FROM review_dispute_actions WHERE review_id=? ORDER BY id',id)
  return {reviewId:id,status:d.status,conclusion:conclusion??null,canCorrect:!!conclusion && !timeline.some(a=>a.kind===party+'-correction'),
    ...(party==='merchant'?{timeline}:{})}
}
export function registerDispute(db:Database,user:User,id:string,input:unknown,now:number){
  const {reason,images}=z.strictObject({reason:reasonField,images:z.array(z.string().min(1)).max(3).default([])}).parse(input)
  return db.transaction(()=>{
    const row=review(db,id)
    ensure(user.identity==='merchant' && ownsReview(db,row.order_id,user.id),403,'仅商品所属商家可登记')
    ensure(!dispute(db,id),409,'这条评价已经登记')
    ensure(new Set(images).size===images.length && images.every(path=>db.one('SELECT 1 FROM product_images WHERE actor_id=? AND path=?',user.id,path)),400,'请选择自己已上传的图片')
    db.run("INSERT INTO review_disputes VALUES(?,?,?,?,'registered')",id,user.id,reason,JSON.stringify(images))
    record(db,id,'register',user,reason,now,row)
    return partyDispute(db,id,'merchant',user.id)
  })
}
export function reviewerQueue(db:Database,user:User){
  ensure(reviewer(user),403,'此账号未获独立复核授权')
  const rows=db.all<{review_id:string;status:string;reason:string;images:string;original:string}>(`SELECT d.*,a.original FROM review_disputes d
    JOIN review_dispute_actions a ON a.review_id=d.review_id AND a.kind='register'
    JOIN evaluations e ON e.public_id=d.review_id JOIN orders o ON o.id=e.order_id
    WHERE d.status<>'concluded' AND d.merchant_id<>? AND o.owner_id<>? ORDER BY a.id`,user.id,user.id)
  return {items:rows.map(d=>{
    const row=review(db,d.review_id)
    const snapshot=JSON.parse(d.original) as ReturnType<typeof original>
    const safe=(s:string)=>redact(s,row)
    return {id:d.review_id,status:d.status,reason:safe(d.reason),images:JSON.parse(d.images) as string[],
      corrections:db.all<{reason:string}>("SELECT reason FROM review_dispute_actions WHERE review_id=? AND kind IN ('buyer-correction','merchant-correction') ORDER BY id",d.review_id).map(a=>safe(a.reason)),
      original:{score:snapshot.score,content:safe(snapshot.content),items:snapshot.items.map(f=>({label:safe(f.label),result:f.result,note:safe(f.note),quote:safe(f.quote)}))}}
  })}
}
export function decide(db:Database,user:User,id:string,step:'accept'|'conclude',input:unknown,now:number){
  ensure(reviewer(user),403,'此账号未获独立复核授权')
  return db.transaction(()=>{
    const row=review(db,id),d=dispute(db,id)
    ensure(d,404,'登记不存在')
    ensure(user.id!==d.merchant_id && user.id!==row.owner_id,403,'复核员必须独立于交易双方')
    if(step==='accept'){
      ensure(d.status==='registered'||d.status==='correction-requested',409,'当前状态无法受理')
      record(db,id,step,user,'',now,row)
      db.run("UPDATE review_disputes SET status='under-review' WHERE review_id=?",id)
    }else{
      ensure(d.status==='under-review',409,'请先受理')
      const {kind,reason}=z.strictObject({kind:kinds,reason:reasonField}).parse(input)
      checkPublicContent(reason)
      ensure(!/(恶意|刷单|恶评)/.test(reason),400,'请用客观事实说明理由')
      ensure(redact(reason,row,[user.id,user.account,user.nickname])===reason,400,'理由中请勿包含个人或交易信息')
      const action=record(db,id,step,user,reason,now,row)
      db.run('INSERT INTO review_dispute_conclusions VALUES(?,?,?,?)',action,kind,reason,Number(kind==='hide'))
      if(kind==='hide') db.run("INSERT OR REPLACE INTO review_moderation VALUES(?,'其他',?,?)",row.order_id,now,user.id)
      else if(kind==='correct') db.run(`DELETE FROM review_moderation WHERE order_id=? AND EXISTS(SELECT 1 FROM review_dispute_actions a
        JOIN review_dispute_conclusions c ON c.action_id=a.id WHERE a.review_id=? AND c.hidden=1 AND a.actor_id=hidden_by AND a.created=hidden_at)`,row.order_id,id)
      db.run("UPDATE review_disputes SET status='concluded' WHERE review_id=?",id)
    }
    return {id}
  })
}
export function requestCorrection(db:Database,user:User,id:string,input:unknown,now:number){
  const parsed=z.strictObject({reason:reasonField}).safeParse(input)
  ensure(parsed.success,400,'请填写5至200字更正理由')
  const {reason}=parsed.data
  return db.transaction(()=>{
    const row=review(db,id),d=dispute(db,id)
    ensure(d && (user.identity==='merchant'?d.merchant_id===user.id:row.owner_id===user.id),403,'仅交易双方可请求更正')
    const summary=partyDispute(db,id,user.identity,user.id)
    ensure(summary?.canCorrect,409,'尚无结论或已请求更正')
    record(db,id,user.identity+'-correction',user,reason,now,row)
    db.run("UPDATE review_disputes SET status='correction-requested' WHERE review_id=?",id)
    return {id}
  })
}
