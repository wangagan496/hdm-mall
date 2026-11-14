import { createHash } from 'node:crypto'
import type { LogisticsChannel, LogisticsEvent, Shipment } from './logistics.ts'
import { channelPost, channelTime, type ChannelFetch } from './channel-http.ts'
import { AppError } from './errors.ts'

const carriers: Record<string, string> = { '顺丰': 'SF', '中通': 'ZTO', '圆通': 'YTO', '申通': 'STO', '韵达': 'YD', '京东': 'JD', '京东物流': 'JD', '邮政': 'YZPY', '邮政EMS': 'EMS', 'EMS': 'EMS', '极兔': 'JTSD', '德邦': 'DBL' }
export class KdniaoChannel implements LogisticsChannel {
  readonly source = 'carrier' as const
  private readonly options: { businessId: string; appKey: string }
  private readonly transport: ChannelFetch
  private readonly cache = new Map<string, { expires: number; value: Promise<LogisticsEvent[]> }>()
  constructor(options: { businessId: string; appKey: string }, transport: ChannelFetch = fetch) { this.options = options; this.transport = transport }
  async query(shipment: Shipment): Promise<LogisticsEvent[]> {
    const carrier = carriers[shipment.carrier] ?? (/^[A-Z0-9]{2,20}$/.test(shipment.carrier) ? shipment.carrier : undefined)
    if (!carrier) throw new AppError(400, '该承运商暂不支持查询，请填写快递鸟承运商编码')
    const key = carrier + ':' + shipment.trackingNo
    const cached = this.cache.get(key)
    if (cached && cached.expires > Date.now()) return structuredClone(await cached.value)
    if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!)
    const value = this.fetchEvents(carrier, shipment.trackingNo)
    this.cache.set(key, { expires: Date.now() + 30 * 60000, value })
    try { return structuredClone(await value) }
    catch (error) { this.cache.delete(key); throw error }
  }
  private async fetchEvents(carrier: string, tracking: string): Promise<LogisticsEvent[]> {
    try {
      const request = JSON.stringify({ ShipperCode: carrier, LogisticCode: tracking })
      const signature = Buffer.from(createHash('md5').update(request + this.options.appKey, 'utf8').digest('hex'), 'utf8').toString('base64')
      const data = JSON.parse(await channelPost('https://api.kdniao.com/Ebusiness/EbusinessOrderHandle.aspx', {
        RequestData: request, EBusinessID: this.options.businessId, RequestType: '1002', DataSign: signature, DataType: '2'
      }, this.transport)) as { EBusinessID: string; ShipperCode: string; LogisticCode: string; Success: boolean; State: string | number; Traces: { AcceptTime: string; AcceptStation: string }[] }
      if (data.Success !== true || data.EBusinessID !== this.options.businessId || data.ShipperCode !== carrier || data.LogisticCode !== tracking ||
        !Array.isArray(data.Traces) || data.Traces.length > 200 || !['0','1','2','3','4'].includes(String(data.State))) throw new Error()
      const traces = data.Traces.map(row => ({ occurredAt: channelTime(row.AcceptTime), description: row.AcceptStation }))
      if (traces.some(row => typeof row.description !== 'string' || !row.description.trim() || row.description.length > 200)) throw new Error()
      traces.sort((a,b) => a.occurredAt-b.occurredAt || a.description.localeCompare(b.description))
      const newest = traces.at(-1)?.occurredAt
      const events = new Map<string, LogisticsEvent>()
      for (const row of traces) {
        const state: LogisticsEvent['state'] = String(data.State) === '3' && row.occurredAt === newest ? 'signed' : 'transit'
        // 1002只有整单状态；不用文案猜测揽收/派送，且仅把最新时间关联到整单签收状态。
        const id = createHash('sha256').update(JSON.stringify([tracking,row.occurredAt,row.description,state])).digest('hex')
        events.set(id, { id, ...row, state })
      }
      return [...events.values()]
    } catch { throw new AppError(502, '物流查询暂时不可用，请稍后重试') }
  }
}
