import { execute, sourceOf, pageMethods } from './native-harness.mjs'
import { orderWriteFailure } from './order-write-boundaries.mjs'

const base = 'mixed-development-h5/'
const evaluationFlow = execute(sourceOf(base + 'features/cart/src/main/ets/presentation/utils/EvaluationSubmitFlow.ets'))
const validation = execute(sourceOf(base + 'commons/storage/src/main/ets/EvaluationValidation.ets'))
const presentation = execute(sourceOf(base + 'features/cart/src/main/ets/presentation/utils/EvaluationPresentation.ets'))

export function evaluationFixture() {
  let user = { id: 'a', token: 'a-token' }, orderId = 'order-a', flushFails = false
  const saved = new Map(), messages = [], submissions = [], queries = [], timers = new Map(), pages = []
  let navigations = 0, nextTimer = 0, keyboardMode = 0
  let load = async () => ({ id: orderId, canEvaluate: true, skus: [] }), submit = async () => ({ id: orderId })
  let flush = async () => { if (flushFails) throw new Error('disk failed') }
  const store = { getSync: (key, fallback) => saved.get(key) ?? fallback, putSync: (key, value) => saved.set(key, value),
    deleteSync: key => saved.delete(key), flush: () => flush() }
  const Page = pageMethods(base + 'features/cart/src/main/ets/presentation/views/EvaluationView.ets', 'EvaluationView', {}, {
    orderWriteFailure,
    ...validation, ...presentation, ...evaluationFlow, KeyboardAvoidMode: { RESIZE: 1 }, PAGE_PATH: { EVALUATION_PAGE: 'evaluation' },
    auth: { getUserInfo: () => user }, storeManager: { getStore: () => store },
    getOrderDetailAPI: (...args) => { queries.push(args); return load(...args) },
    commentOrderAPI: async (...args) => { submissions.push(args); return submit(...args) },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id),
  })
  const newPage = () => {
    const page = new Page(); page.user = user
    page.getUIContext = () => ({ getKeyboardAvoidMode: () => keyboardMode, setKeyboardAvoidMode: value => { keyboardMode = value },
      getPromptAction: () => ({ showToast: value => messages.push(value.message) }) })
    page.stackPath = { getParamByName: () => [orderId], pop: () => navigations++ }
    page.leaveToOrderList = () => { navigations++; page.leaving = true }
    pages.push(page)
    return page
  }
  const setUser = value => { user = value; for (const page of pages) page.user = value }
  return { newPage, saved, messages, submissions, queries, timers, navigations: () => navigations, keyboardMode: () => keyboardMode,
    setUser, switchUser: value => { setUser(value); for (const page of pages) page.reloadForCurrentAccount?.() },
    setOrderId: value => { orderId = value }, setLoad: fn => { load = fn }, setSubmit: fn => { submit = fn },
    setFlush: fn => { flush = fn }, failFlush: () => { flushFails = true } }
}
