import { GlobalVariable } from 'constants'
import { demoOrderStore } from 'storage'

/**
 * 订单操作与本地演示覆盖层的统一入口。
 *
 * 服务端模式下提醒发货不改变订单状态，由商家发货推进到待收货。
 * 仅 GlobalVariable.DEMO_ORDER_FLOW 打开时，本地覆盖层才会推进（提醒发货 → 待收货、确认收货 → 待评价）。
 * 开启演示时接口失败也会按本地覆盖层推进；关闭时不写入覆盖层，失败原样抛给调用方提示。
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
  if (GlobalVariable.DEMO_ORDER_FLOW) {
    await demoOrderStore.setOverlay(orderId, nextState)
  }
}
