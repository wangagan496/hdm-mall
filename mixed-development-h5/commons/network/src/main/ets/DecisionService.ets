import axios, { AxiosResponse } from '@ohos/axios'
import { GlobalVariable } from 'constants'

export interface DecisionServiceResponse {
  project: string
  module: string
  result: string | number | null
  confidence: number | null
  provider: string
  fallback: boolean
  fallback_reason?: string | null
}

const decisionInstance = axios.create({
  baseURL: GlobalVariable.DECISION_SERVICE_URL,
  timeout: 4000
})

export class DecisionService {
  static async routeOrderMessage(state: string): Promise<DecisionServiceResponse> {
    const res: AxiosResponse<DecisionServiceResponse> = await decisionInstance.post<DecisionServiceResponse>('/api/decision/template', {
      project: 'hdm-mall',
      module: 'order-routing',
      state
    })
    return res.data
  }
}
