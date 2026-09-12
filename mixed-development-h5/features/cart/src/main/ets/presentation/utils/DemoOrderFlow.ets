import { GlobalVariable } from 'constants'
import { demoOrderStore } from 'storage'

/**
 * 订单状态推进（提醒发货 → 待收货、确认收货 → 待评价、评价 → 已评价）的统一入口。
 *
 * 先请求服务端；成功后写入本地覆盖层，列表/详情按「服务端状态 + 覆盖层」合并展示。
 * 公开演示 API 对发货、收货这类操作可能直接返回业务失败，为了让演示流程能走完，
 * GlobalVariable.DEMO_ORDER_FLOW 打开时接口失败也会按本地覆盖层推进——这是有意的演示行为，
 * 不是吞掉异常；关闭开关后只有服务端成功才会推进状态，失败原样抛给调用方提示。
 */
export async function advanceOrderState(
  orderId: string,
  nextState: number,
  serverTask: () => Promise<void>
): Promise<void> {
  try {
    await serverTask()
  } catch (error) {
    if (!GlobalVariable.DEMO_ORDER_FLOW) {
      const reason: Error = error as Error
      throw reason
    }
  }
  await demoOrderStore.setOverlay(orderId, nextState)
}
