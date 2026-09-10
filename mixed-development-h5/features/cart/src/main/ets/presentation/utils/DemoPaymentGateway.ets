import { PayResultParams } from 'models'
import { isDemoPaymentOrder } from './PaymentPresentation'

export enum PaymentStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  PENDING = 'pending'
}

export interface PaymentGatewayResult {
  status: PaymentStatus
  isDemo: boolean
}

// A real SDK adapter must accept a server-signed order string; the demo accepts only local ids.
export interface PaymentGateway {
  requestPayment(orderInfo: string): Promise<PaymentGatewayResult>
}

export interface PaymentResultRouteParams extends PayResultParams {
  demoStatus?: PaymentStatus
}

export class DemoPaymentGateway implements PaymentGateway {
  private scenario: PaymentStatus

  constructor(scenario: PaymentStatus) {
    this.scenario = scenario
  }

  async requestPayment(orderInfo: string): Promise<PaymentGatewayResult> {
    if (!isDemoPaymentOrder(orderInfo)) {
      throw new Error('演示支付不能处理真实订单')
    }
    return { status: this.scenario, isDemo: true }
  }
}

export function getDemoPaymentStatusText(status: PaymentStatus): string {
  switch (status) {
    case PaymentStatus.SUCCESS:
      return '模拟支付成功'
    case PaymentStatus.CANCELLED:
      return '模拟取消支付'
    case PaymentStatus.PENDING:
      return '模拟支付待确认'
    default:
      return '模拟支付失败'
  }
}
