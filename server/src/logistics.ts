import { z } from 'zod'
import type { Database } from './database.ts'
import type { Clock } from './clock.ts'
import type { User } from './accounts.ts'
import { ensure } from './errors.ts'

export const shipmentSchema = z.object({ carrier:z.string().trim().min(2).max(30).regex(/^[\p{L}\p{N} .-]+$/u),
  trackingNo:z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9-]{5,39}$/) })
export const logisticsEventSchema = z.object({id:z.string().min(1).max(120),state:z.enum(['collected','transit','delivering','signed']),
  occurredAt:z.number().int().nonnegative().safe(),description:z.string().trim().min(1).max(200)}).strict()
export type LogisticsEvent = z.infer<typeof logisticsEventSchema>
export interface Shipment {orderId:string;carrier:string;trackingNo:string;source:string;state:string;created:number}
export interface LogisticsChannel { readonly source?: 'carrier'; query(shipment:Shipment):Promise<LogisticsEvent[]>|LogisticsEvent[] }
export class MockLogisticsChannel implements LogisticsChannel {
  private events = new Map<string,LogisticsEvent[]>()
  push(id:string,events:LogisticsEvent[]) { this.events.set(id,events.map(event=>structuredClone(event))) }
  query(shipment:Shipment) { return this.events.get(shipment.orderId) ?? [] }
}
export function registerShipment(db:Database,id:string,input:unknown,now:number,source:'mock'|'unavailable') {
  const data = shipmentSchema.parse(input)
  db.run("INSERT INTO shipments(order_id,carrier,tracking_no,source,state,created) VALUES(?,?,?,?,'waiting',?)",id,data.carrier,data.trackingNo,source,now)
  return data
}
export function shipmentDetail(db:Database,id:string) {
  const shipment=db.one<Shipment>('SELECT order_id orderId,carrier,tracking_no trackingNo,source,state,created FROM shipments WHERE order_id=?',id)
  if (!shipment) return null
  const events=db.all<LogisticsEvent>('SELECT id,state,occurred_at occurredAt,description FROM logistics_events WHERE order_id=? ORDER BY occurred_at,id',id)
  return {...shipment,events}
}
const ranks:Record<string,number>={waiting:0,collected:1,transit:2,delivering:3,signed:4}
export class Logistics {
  private db:Database
  private clock:Clock
  private channel?:LogisticsChannel
  private canRead:(user:User,id:string)=>boolean
  constructor(db:Database,clock:Clock,channel:LogisticsChannel|undefined,canRead:(user:User,id:string)=>boolean) { this.db=db;this.clock=clock;this.channel=channel;this.canRead=canRead }
  async read(user:User,id:string) {
    ensure(this.db.one('SELECT id FROM orders WHERE id=?',id),404,'订单不存在')
    // 与订单详情同一权限：下单人、付款人、仍绑定的代收亲友、实际收货人和商家。
    ensure(this.canRead(user,id),403,'无权查看此订单的物流')
    await this.refresh(id)
    return shipmentDetail(this.db,id)
  }
  private async refresh(id:string) {
    const shipment=shipmentDetail(this.db,id)
    if (!shipment||!this.channel) return
    const events=z.array(logisticsEventSchema).max(200).parse(await this.channel.query(shipment))
    ensure(events.every(event=>event.occurredAt>=shipment.created&&event.occurredAt<=this.clock.now()),400,'物流事件时间不在有效范围内')
    this.db.transaction(()=>{
      let state=this.db.one<{state:string}>('SELECT state FROM shipments WHERE order_id=?',id)!.state
      for (const event of events.sort((a,b)=>a.occurredAt-b.occurredAt||a.id.localeCompare(b.id))) {
        const old=this.db.one<LogisticsEvent>('SELECT id,state,occurred_at occurredAt,description FROM logistics_events WHERE order_id=? AND id=?',id,event.id)
        if(old){ensure(old.state===event.state&&old.occurredAt===event.occurredAt&&old.description===event.description,409,'同一物流事件编号不能更改内容');continue}
        this.db.run('INSERT OR IGNORE INTO logistics_events(order_id,id,state,occurred_at,description) VALUES(?,?,?,?,?)',id,event.id,event.state,event.occurredAt,event.description)
        if(ranks[event.state]!>ranks[state]!) state=event.state
      }
      this.db.run('UPDATE shipments SET state=? WHERE order_id=?',state,id)
      if(this.channel?.source === 'carrier') this.db.run("UPDATE shipments SET source='carrier' WHERE order_id=?",id)
      const signed=this.db.one<{at:number|null}>("SELECT MIN(occurred_at) at FROM logistics_events WHERE order_id=? AND state='signed'",id)!.at
      if(signed!==null)this.db.run('UPDATE orders SET signed_at=? WHERE id=?',signed,id)
    })
  }
  async pushMock(id:string,input:unknown) {
    ensure(this.channel instanceof MockLogisticsChannel,403,'当前环境未启用模拟物流')
    ensure(shipmentDetail(this.db,id),404,'尚未登记发货信息')
    this.channel.push(id,z.array(logisticsEventSchema).max(200).parse(input))
    await this.refresh(id)
    return shipmentDetail(this.db,id)
  }
}
