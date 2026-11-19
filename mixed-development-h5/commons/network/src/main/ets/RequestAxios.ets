import axios, { AxiosError, AxiosResponse, InternalAxiosRequestConfig, FormData } from '@ohos/axios'
import { GlobalVariable } from 'constants'
import { window } from '@kit.ArkUI'
import { common } from '@kit.AbilityKit'
import { HDMUser, IdentityContext, parseIdentityContext } from 'models'

function showToast(message: string): void {
  const ctx = AppStorage.get<common.UIAbilityContext>(GlobalVariable.ABILITY_CONTEXT_KEY)
  if (!ctx) {
    return
  }
  window.getLastWindow(ctx).then((win) => {
    try {
      win.getUIContext().getPromptAction().showToast({ message })
    } catch {
    }
  }).catch(() => {
  })
}

const GET_RETRY_DELAYS: number[] = [350, 1000]

/** 业务失败（接口返回 code !== SUCCESS_CODE）时携带 HTTP 状态码，供调用方区分错误类型。 */
export class BusinessError extends Error {
  httpStatus: number

  constructor(message: string, httpStatus: number) {
    super(message)
    this.httpStatus = httpStatus
  }
}

export function isRetryableStatus(status?: number): boolean {
  return status === undefined || status === 408 || status === 429 || status >= 500
}

function isRetryableError(error: AxiosError): boolean {
  if (!error.code && !error.response) {
    return false
  }
  return isRetryableStatus(error.response?.status)
}

function waitForRetry(delay: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delay)
  })
}

/**
 * 只对幂等 GET 做有限重试。
 * 不可重试或重试耗尽时必须把原始错误原样抛出：响应拦截器产出的 BusinessError 携带 httpStatus，
 * 调用方（如取消订单的兼容降级）依赖它区分"接口不存在"和"业务拒绝"，包一层 new Error 会把这个信息丢掉。
 */
async function getWithRetry<T>(request: () => Promise<T>): Promise<T> {
  let attempt: number = 0
  while (true) {
    try {
      return await request()
    } catch (error) {
      const reason: Error = error as Error
      if (reason instanceof BusinessError) {
        throw reason
      }
      if (!isRetryableError(error as AxiosError) || attempt >= GET_RETRY_DELAYS.length) {
        throw reason
      }
      await waitForRetry(GET_RETRY_DELAYS[attempt])
      attempt++
    }
  }
}

export function executeGetWithRetry<T>(request: () => Promise<T>): Promise<T> {
  return getWithRetry(request)
}

const instance = axios.create({
  baseURL: GlobalVariable.BASE_URL,
  timeout: 10000
})

const rawInstance = axios.create({ timeout: 10000 })
let sessionExpiredHandler: ((token: string) => Promise<boolean>) | undefined = undefined
let identityChangedHandler: ((token: string, context: IdentityContext) => void) | undefined = undefined

interface IdentityErrorResponse {
  reason?: string
  result?: Object
}

export class IdentityChangedError extends BusinessError {
  constructor() { super('身份已切换，请返回后重试', 409) }
}

function currentUser(): HDMUser | undefined {
  return AppStorage.get<HDMUser>(GlobalVariable.USER_INFO_KEY)
}

function requestHeaders(token?: string, silent: boolean = false, user: HDMUser | undefined = currentUser()): Record<string, string> {
  const headers: Record<string, string> = {}
  const requestToken = token ?? user?.token
  if (silent) headers.xSilentError = '1'
  if (requestToken) {
    headers.Authorization = 'Bearer ' + requestToken
    if (user && user.token === requestToken && user.identity && user.identityRevision !== undefined) {
      headers['X-HDM-Identity'] = user.identity
      headers['X-HDM-Identity-Revision'] = String(user.identityRevision)
    }
  }
  return headers
}

function staleRequest(config?: InternalAxiosRequestConfig): boolean {
  const headers = config?.headers
  const revision = headers?.['X-HDM-Identity-Revision'] as string | undefined
  const authorization: string = String(headers?.Authorization || '')
  if (!authorization || config?.url === '/logout' || config?.url === '/member/consents') return false
  const user = currentUser()
  if (!user?.token || authorization !== 'Bearer ' + user.token) return true
  if (revision === undefined) return user.identityRevision !== undefined
  return String(revision) !== String(user.identityRevision) || headers?.['X-HDM-Identity'] !== user.identity
}

instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (staleRequest(config)) throw new IdentityChangedError()
  const user = currentUser()
  if (user?.status === 'deleting' && config.headers.Authorization === 'Bearer ' + user.token && config.method?.toUpperCase() !== 'GET') {
    const url: string = config.url || ''
    const followUp: boolean = ['/logout', '/member/consents', '/member/consents/withdraw', '/member/account-deletion', '/member/account-deletion/cancel', '/member/after-sales/images'].includes(url) ||
      /^\/member\/order\/[^/]+\/(receipt|payments\/refresh|after-sales|cancel-requests|cancel-requests\/[^/]+\/withdraw)$/.test(url) ||
      /^\/member\/after-sales\/[^/]+\/(withdraw|ship-back)$/.test(url)
    if (!followUp) throw new BusinessError('账号正在注销中', 403)
  }
  return config
}, (error: AxiosError) => {
  // 抛出请求错误，让等待请求的代码进入失败处理。
  const requestError: Error = error as Error
  throw requestError
})

instance.interceptors.response.use((response: AxiosResponse) => {
  if (staleRequest(response.config)) throw new IdentityChangedError()
  if (response.config.url === '/goods' && response.status === 200 && response.data.id) {
    return response.data
  }
  if (response.data.code === GlobalVariable.SUCCESS_CODE) {
    return response.data.result
  }
  if (!response.config.headers?.xSilentError) {
    showToast(response.data.msg)
  }
  // 携带 HTTP 状态码，调用方才能区分"接口不存在"与业务失败（如订单不可取消）。
  throw new BusinessError(response.data.msg, response.status)
}, async (error: AxiosError) => {
  if (staleRequest(error.config)) throw new IdentityChangedError()
  const body = error.response?.data as IdentityErrorResponse | undefined
  if (error.response?.status === 409 && body?.reason === 'IDENTITY_CHANGED') {
    const context = parseIdentityContext(JSON.stringify(body.result ?? null))
    const authorization = String(error.config?.headers?.Authorization || '')
    if (context && authorization.startsWith('Bearer ')) identityChangedHandler?.(authorization.substring(7), context)
    throw new IdentityChangedError()
  }
  if (error.response?.status === 401 && sessionExpiredHandler) {
    const authorization: string = String(error.config?.headers?.Authorization || '')
    const token: string = authorization.startsWith('Bearer ') ? authorization.substring(7) : ''
    if (token) {
      try {
        if (await sessionExpiredHandler(token)) {
          showToast('登录已过期，请重新登录')
        }
      } catch {
        showToast('登录已过期，本地资料清理失败，请重新登录')
      }
      throw error as Error
    }
  }
  if (!error.config?.headers?.xSilentError) {
    const res = error.response?.data as object
    if (res) {
      showToast(res["msg"])
    }
  }
  // 是否弹提示不影响失败传递，调用方仍需处理这个错误。
  const requestError: Error = error as Error
  throw requestError
})

export class RequestAxios {
  static async getImageForSession(path: string, token: string): Promise<ArrayBuffer> {
    if (!/^\/uploads\/[a-f0-9-]{36}\.jpg$/.test(path)) throw new Error('图片路径无效')
    return RequestAxios.readPrivateJpeg(path, token)
  }
  static getSourceMaterialForSession(productId: string, materialId: string, token: string): Promise<ArrayBuffer> {
    return RequestAxios.readPrivateJpeg('/merchant/products/' + encodeURIComponent(productId) +
      '/source-materials/' + encodeURIComponent(materialId) + '/original', token)
  }
  private static async readPrivateJpeg(path: string, token: string): Promise<ArrayBuffer> {
    const response: AxiosResponse<ArrayBuffer> = await rawInstance.get<ArrayBuffer, AxiosResponse<ArrayBuffer>>(GlobalVariable.BASE_URL + path,
      { responseType: 'array_buffer', headers: requestHeaders(token) })
    if (staleRequest(response.config)) throw new IdentityChangedError()
    return response.data
  }
  static postMultipartForSession<T>(url: string, bytes: ArrayBuffer, requestKey: string, token: string, orderId?: string, applicationKey?: string): Promise<T> {
    const form = new FormData()
    form.append('requestKey', requestKey)
    if (orderId) form.append('orderId', orderId)
    if (applicationKey) form.append('applicationKey', applicationKey)
    return RequestAxios.postJpeg<T>(url, bytes, form, token)
  }
  static postSourceMaterialForSession<T>(url: string, bytes: ArrayBuffer, metadata: string, token: string): Promise<T> {
    const form = new FormData()
    form.append('metadata', metadata)
    return RequestAxios.postJpeg<T>(url, bytes, form, token)
  }
  private static postJpeg<T>(url: string, bytes: ArrayBuffer, form: FormData, token: string): Promise<T> {
    form.append('file', bytes, { filename: 'product.jpg', type: 'image/jpeg' })
    const headers = requestHeaders(token, true)
    headers['Content-Type'] = 'multipart/form-data'
    return instance.post<null, T>(url, form, { headers })
  }
  // 重试期间始终使用发起请求的会话，不借用后来登录的账号。
  static getForSession<T>(url: string, token: string): Promise<T> {
    const headers = requestHeaders(token, true)
    return executeGetWithRetry<T>(() => instance.get<null, T>(url, {
      headers
    }))
  }

  static putForSession<T>(url: string, data: object, token: string): Promise<T> {
    return instance.put<null, T>(url, data, { headers: requestHeaders(token, true) })
  }

  static postWithSession<T>(url: string, data: object, token: string, user?: HDMUser, timeout?: number): Promise<T> {
    return instance.post<null, T>(url, data, { headers: requestHeaders(token, true, user), timeout })
  }

  static deleteForSession<T>(url: string, token: string): Promise<T> {
    return instance.delete<null, T>(url, { data: {}, headers: requestHeaders(token, true) })
  }

  static setSessionExpiredHandler(handler: (token: string) => Promise<boolean>): void {
    sessionExpiredHandler = handler
  }

  static setIdentityChangedHandler(handler: (token: string, context: IdentityContext) => void): void {
    identityChangedHandler = handler
  }

  static postForSession<T>(url: string, token: string, user?: HDMUser): Promise<T> {
    return instance.post<null, T>(url, {}, {
      timeout: 3000, headers: requestHeaders(token, true, user)
    })
  }
  static get<T>(url: string, params?: object): Promise<T> {
    const headers = requestHeaders()
    return executeGetWithRetry<T>(() => instance.get<null, T>(url, { params, headers }))
  }

  // 请求失败时不自动弹提示；错误仍交给调用方处理。
  static getWithoutToast<T>(url: string, params?: object): Promise<T> {
    const headers = requestHeaders(undefined, true)
    return executeGetWithRetry<T>(() => instance.get<null, T>(url, { params, headers }))
  }

  static getRaw<T>(url: string, params?: object): Promise<T> {
    return executeGetWithRetry<T>(() => rawInstance.get<null, T>(url, { params }))
  }

  static post<T>(url: string, data?: object): Promise<T> {
    // 无业务参数也发送空 JSON，避免 Axios 默认的表单类型被 JSON 接口拒绝。
    const anonymous = ['/login', '/login/huawei', '/register'].includes(url)
    return instance.post<null, T>(url, data ?? {}, { headers: requestHeaders(anonymous ? '' : undefined) })
  }

  static postSilent<T>(url: string, data?: object): Promise<T> {
    return instance.post<null, T>(url, data ?? {}, { headers: requestHeaders(undefined, true) })
  }

  static put<T>(url: string, data?: object): Promise<T> {
    return instance.put<null, T>(url, data ?? {}, { headers: requestHeaders() })
  }

  static putSilent<T>(url: string, data?: object): Promise<T> {
    return instance.put<null, T>(url, data ?? {}, { headers: requestHeaders(undefined, true) })
  }

  static delete<T>(url: string, data?: object): Promise<T> {
    return instance.delete<null, T>(url, { data, headers: requestHeaders() })
  }
}
