import type { Database } from './database.ts'
import { evaluationItems } from './evaluations.ts'
import { beijingDate } from './channel-bill.ts'

export const REVIEW_SAMPLE_THRESHOLD = 3
const limited = '样本有限，暂不足以判断'
const currentEdition = `p.status='on' AND i.review_edition=p.review_edition AND COALESCE(s.receipt_id,'')=COALESCE(
  (SELECT receipt_id FROM promise_publications WHERE product_id=i.product_id ORDER BY rowid DESC LIMIT 1),'')`
interface Group {
  sku:string; receipt:string; version:string; edition:number; spec:string; counts:number; neutral:number; negative:number
  product:number; logistics:number|null; service:number|null; larger:number; fits:number; smaller:number
  largeHalf:number; largeFull:number; smallHalf:number; smallFull:number
}
function sizeSummary(group?:Group) {
  const count = group ? group.larger+group.fits+group.smaller : 0
  if(!group || count<REVIEW_SAMPLE_THRESHOLD) return {counts:count,sampleSufficient:false,conclusion:limited}
  const {larger,fits,smaller,largeHalf,largeFull,smallHalf,smallFull}=group
  let conclusion='尺码反馈暂无一致倾向'
  for(const [votes,half,full,label] of [[larger,largeHalf,largeFull,'偏大'],[fits,0,0,'合适'],[smaller,smallHalf,smallFull,'偏小']] as const){
    if(votes>count/2) conclusion='多数人说'+label+(half>count/2?'半码':full>count/2?'一码':'')
  }
  return {counts:count,sampleSufficient:true,larger,true:fits,smaller,largeHalf,largeFull,smallHalf,smallFull,conclusion}
}

function publicGroups(db:Database,product:string,sku:string|undefined,version:string|undefined) {
  return db.all<Group>(`SELECT i.sku_id sku,coalesce(s.receipt_id,'') receipt,i.review_edition edition,
    coalesce(s.snapshot->>'templateVersion','') version,i.spec, count(*) counts,
    count(CASE WHEN e.score=3 THEN 1 END) neutral,count(CASE WHEN e.score<3 THEN 1 END) negative,
    avg(e.score) product,avg(e.logistics_score) logistics,avg(e.service_score) service,
    count(CASE WHEN z.size_fit='larger' THEN 1 END) larger,count(CASE WHEN z.size_fit='true' THEN 1 END) fits,
    count(CASE WHEN z.size_fit='smaller' THEN 1 END) smaller,
    count(CASE WHEN z.size_fit='larger' AND z.size_shift='half' THEN 1 END) largeHalf,
    count(CASE WHEN z.size_fit='larger' AND z.size_shift='full' THEN 1 END) largeFull,
    count(CASE WHEN z.size_fit='smaller' AND z.size_shift='half' THEN 1 END) smallHalf,
    count(CASE WHEN z.size_fit='smaller' AND z.size_shift='full' THEN 1 END) smallFull
    FROM order_items i JOIN evaluations e USING(order_id) JOIN products p ON p.id=i.product_id
    LEFT JOIN order_item_promise_snapshots s USING(order_id,sku_id) LEFT JOIN evaluation_sizes z USING(order_id,sku_id)
    WHERE i.product_id=? AND ${currentEdition} AND NOT EXISTS(SELECT 1 FROM review_moderation m WHERE m.order_id=e.order_id)
    AND (? IS NULL OR i.sku_id=?) AND (? IS NULL OR coalesce(s.snapshot->>'templateVersion','')=?)
    GROUP BY i.sku_id,receipt,version,i.review_edition`,product,sku??null,sku??null,version??null,version??null)
}

interface Query {page:number;pageSize:number;skuId?:string;templateVersion?:string}
interface Row {
  address:string; buyer_account:string; nickname:string; status:string; order_id:string; public_id:string; content:string; created:number; score:number; logistics_score:number|null;
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
    scope += ' AND '+currentEdition
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
  const groups=publicGroups(db,product,skuId,query.templateVersion)
  const group=groups.length===1 ? groups[0] : undefined
  const counts=merchant ? db.one<{n:number}>(`SELECT count(*) n ${from}`,...bindings)!.n : groups.reduce((sum,g)=>sum+g.counts,0)
  const summary=group && group.counts===counts && counts>=REVIEW_SAMPLE_THRESHOLD
    ? {counts,sampleSufficient:true,neutral:group.neutral,negative:group.negative,product:group.product,logistics:group.logistics,service:group.service}
    : {counts,sampleSufficient:false,conclusion:limited}
  const offset = (query.page-1)*query.pageSize
  const rows = offset>=counts ? [] : db.all<Row>(`SELECT e.*,u.nickname,u.status,u.account buyer_account,o.address,o.received_at,o.received_by,o.signed_at,
    (SELECT content FROM merchant_evaluation_replies r WHERE r.order_id=e.order_id) reply ${from}
    ORDER BY e.created DESC,e.order_id LIMIT ? OFFSET ?`,...bindings,query.pageSize,offset)
  const items = rows.map(row=>{
    const orderSpecs=db.all<{sku:string;spec:string;receipt:string;version:string;edition:number}>(`SELECT i.sku_id sku,i.spec,i.review_edition edition,
      coalesce(s.receipt_id,'') receipt,coalesce(s.snapshot->>'templateVersion','') version FROM order_items i
      LEFT JOIN order_item_promise_snapshots s USING(order_id,sku_id) WHERE i.order_id=? AND i.product_id=?`,row.order_id,product)
    const disclosed=(item:typeof orderSpecs[number])=>groups.some(g=>g.sku===item.sku && g.receipt===item.receipt && g.version===item.version && g.edition===item.edition && g.counts>=REVIEW_SAMPLE_THRESHOLD)
    const address=JSON.parse(row.address)
    const redactions=[address.contact,address.address,address.receiver,address.fullLocation,...String(address.fullLocation??'').split(/\s+/),
      row.buyer_account,row.order_id,...orderSpecs.map(item=>item.sku),...orderSpecs.filter(item=>!disclosed(item)).map(item=>item.spec)].filter((s):s is string=>typeof s==='string' && s.length>0)
    const safeText = (value:string) => {
      let masked=value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱已隐藏]')
        .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9](?:[- ]?\d){9}(?!\d)/g,'[电话已隐藏]')
      for(const privateValue of redactions) masked=masked.replaceAll(privateValue,'[已隐藏]')
      return masked
    }
    const fields = evaluationItems(db,row.order_id,skuId).filter(field=>db.one(
      `SELECT 1 FROM order_items i JOIN products p ON p.id=i.product_id LEFT JOIN order_item_promise_snapshots s
       ON s.order_id=i.order_id AND s.sku_id=i.sku_id WHERE i.order_id=? AND i.sku_id=? AND ${scope}`,row.order_id,field.skuId,...bindings)).map(({skuId:_,...field})=>({...field,note:safeText(field.note),quote:safeText(field.quote),value:field.value && safeText(field.value)}))
    const badges:string[]=[]
    const receipt = row.received_at !== null && (!!row.received_by || !!row.signed_at)
    if(receipt) badges.push('已真实收货')
    if(receipt && fields.length && fields.every(f=>f.quote && f.templateVersion)) badges.push('对照承诺逐条打分')
    const name = Array.from(row.nickname)
    const nickname = row.status==='deleted' ? '已注销用户' : (name[0]??'')+'***'+(name.length>2 ? name.at(-1) : '')
    return { id:row.public_id,score:row.score,productScore:row.score,logisticsScore:row.logistics_score,
      spec:[...new Set(orderSpecs.filter(item=>skuId===undefined || item.sku===skuId).map(item=>disclosed(item)?item.spec:'其他规格'))].join('、'),
      serviceScore:row.service_score,serviceOccurred:!!row.service_occurred,content:safeText(row.content),createTime:beijingDate(row.created),
      member:{nickname},pictures:[],items:fields,badges,receiptBasis:receipt ? (row.signed_at?'订单签收':'买家确认收货') : null,reply:row.reply && safeText(row.reply) }
  })
  return {items,counts,pages:Math.ceil(counts/query.pageSize),page:query.page,pageSize:query.pageSize,summary,sizeSummary:sizeSummary(group),
    ...(merchant?{sizeGroups:groups.filter(g=>g.larger+g.smaller+g.fits>0 && g.counts>=REVIEW_SAMPLE_THRESHOLD).map(g=>({spec:g.spec,sizeSummary:sizeSummary(g)}))}:{})}
}
