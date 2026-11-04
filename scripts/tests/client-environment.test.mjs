import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { isIP } from 'node:net'
import { URL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { execute, sourceOf } from './native-harness.mjs'

const requireH5 = createRequire(new URL('../../shoph5-vue3/package.json', import.meta.url))
const axios = requireH5('axios')
const fields = { APP_ENV: 'production', API_BASE_URL: 'https://api.fixture.com', DECISION_SERVICE_URL: '', DEMO_ORDER_FLOW: false }
const environment = execute(sourceOf('mixed-development-h5/build-support/client-environment.ts'), {
  'node:url': { URL }, 'node:net': { isIP },
})

test('构建配置区分开发测试正式环境，发布缺配置、降级环境及演示开关均被拒绝', () => {
  const { resolveClientEnvironment: resolve } = environment
  assert.equal(resolve('debug', {}).API_BASE_URL, 'http://127.0.0.1:3000')
  assert.equal(resolve('debug', {}).DEMO_ORDER_FLOW, false)
  assert.equal(resolve('debug', { HDM_DEMO_ORDER_FLOW: 'true' }).DEMO_ORDER_FLOW, true)
  assert.throws(() => resolve('release', {}), /HDM_API_BASE_URL/)
  assert.throws(() => resolve('release', { HDM_APP_ENV: 'development' }), /production/)
  assert.throws(() => resolve('release', { HDM_APP_ENV: 'test' }), /production/)
  assert.throws(() => resolve('debug', { HDM_APP_ENV: 'test' }), /HDM_API_BASE_URL/)
  assert.throws(() => resolve('debug', { HDM_APP_ENV: 'other' }), /HDM_APP_ENV/)
  assert.throws(() => resolve('debug', { HDM_DEMO_ORDER_FLOW: 'yes' }), /HDM_DEMO_ORDER_FLOW/)
  assert.throws(() => resolve('release', { HDM_API_BASE_URL: fields.API_BASE_URL, HDM_DEMO_ORDER_FLOW: 'true' }), /forbidden/)
  assert.throws(() => resolve('debug', { HDM_APP_ENV: 'test', HDM_API_BASE_URL: 'http://127.0.0.1:3001', HDM_DEMO_ORDER_FLOW: 'true' }), /forbidden/)
  assert.equal(resolve('debug', { HDM_APP_ENV: 'test', HDM_API_BASE_URL: 'http://127.0.0.1:3001' }).API_BASE_URL, 'http://127.0.0.1:3001')
  assert.deepEqual(JSON.parse(JSON.stringify(resolve('release', { HDM_API_BASE_URL: fields.API_BASE_URL }))), fields)
})

test('正式地址拒绝本机与内网字面量、非HTTPS、凭证及路径，错误不泄露输入', () => {
  const { resolveClientEnvironment: resolve } = environment
  const bad = ['http://api.fixture.com', 'https://127.0.0.1', 'https://127.1', 'https://0x7f000001',
    'https://2130706433', 'https://10.0.2.2:8765', 'https://192.168.1.5', 'https://[::1]',
    'https://[::ffff:127.0.0.1]', 'https://localhost', 'https://api.localhost.', 'https://dev.local',
    'https://api.internal', 'https://host', 'https://api.example.com', 'https://api.test',
    "https://a'b.com", 'https://api..fixture.com', 'https://-api.fixture.com',
    'https://name:secret@api.fixture.com', 'https://api.fixture.com/path', 'https://api.fixture.com?q=secret',
    'https://api.fixture.com#secret', ' https://api.fixture.com', 'https://api.fixture.com\\path']
  for (const value of bad) for (const key of ['HDM_API_BASE_URL', 'HDM_DECISION_SERVICE_URL']) {
    assert.throws(() => resolve('release', { HDM_API_BASE_URL: fields.API_BASE_URL, [key]: value }), error => {
      assert.match(error.message, new RegExp(key)); assert.equal(error.message.includes('secret'), false); return true
    }, value)
  }
  assert.equal(resolve('release', { HDM_API_BASE_URL: 'https://API.fixture.com:8443/' }).API_BASE_URL, 'https://api.fixture.com:8443')
})

test('实际Hvigor插件每次注入新字段并保留原构建选项，直接release也执行校验', () => {
  const product = { name: 'default', buildOption: { arkOptions: { buildProfileFields: { OTHER: 'keep' }, branchElimination: true } } }
  let profile = { app: { products: [product] } }, mode = 'debug', writes = 0
  const env = {}
  const { default: config } = execute(sourceOf('mixed-development-h5/hvigorfile.ts'), {
    '@ohos/hvigor': {}, '@ohos/hvigor-ohos-plugin': { OhosPluginId: { OHOS_APP_PLUGIN: 'app' } },
    './build-support/client-environment': environment, fs: { existsSync: () => false },
  }, { process: { env } })
  const context = { getBuildMode: () => mode, getCurrentProduct: () => ({ getProductName: () => 'default' }),
    getBuildProfileOpt: () => profile, setBuildProfileOpt: value => { profile = value; writes++ } }
  const node = { afterNodeEvaluate: callback => callback(), getContext: name => { assert.equal(name, 'app'); return context } }
  config.plugins[0].apply(node)
  assert.equal(product.buildOption.arkOptions.buildProfileFields.API_BASE_URL, 'http://127.0.0.1:3000')
  mode = 'release'; assert.throws(() => config.plugins[0].apply(node), /HDM_API_BASE_URL/); assert.equal(writes, 1)
  env.HDM_API_BASE_URL = fields.API_BASE_URL; config.plugins[0].apply(node)
  assert.equal(product.buildOption.arkOptions.buildProfileFields.API_BASE_URL, fields.API_BASE_URL)
  assert.equal(product.buildOption.arkOptions.buildProfileFields.OTHER, 'keep'); assert.equal(product.buildOption.arkOptions.branchElimination, true)
})

test('原生网络与演示开关使用本次构建字段，不保留源码开发地址', () => {
  const { GlobalVariable } = execute(sourceOf('mixed-development-h5/commons/constants/src/main/ets/GlobalVariable.ets'), {
    BuildProfile: { __esModule: true, default: fields },
  })
  assert.equal(GlobalVariable.BASE_URL, fields.API_BASE_URL)
  assert.equal(GlobalVariable.DECISION_SERVICE_URL, '')
  assert.equal(GlobalVariable.DEMO_ORDER_FLOW, false)
})

function webRequest(env, nativeApp) {
  const calls = []
  const { request } = execute(sourceOf('shoph5-vue3/src/api/index.ts').replaceAll('import.meta.env', '(' + JSON.stringify(env) + ')'), {
    axios: { __esModule: true, default: axios },
  }, { window: { nativeApp } })
  request.defaults.adapter = async config => { calls.push(config); return { data: {}, status: 200, statusText: 'OK', headers: {}, config } }
  return { request, calls }
}

test('内嵌网页始终使用原生构建地址，旧网页环境变量不能改送登录凭证', async () => {
  const f = webRequest({ VITE_API_BASE_URL: 'https://old.fixture.com' }, {
    getApiBaseUrl: () => 'https://current.fixture.com', getUser: () => ({ token: 'current' }),
  })
  await f.request.get('/member/profile')
  assert.equal(f.calls[0].baseURL, 'https://current.fixture.com')
  assert.equal(f.calls[0].headers.Authorization, 'Bearer current')
})

test('正式网页缺失地址或原生桥地址为空时不发送请求', async () => {
  for (const nativeApp of [undefined, { getApiBaseUrl: () => '', getUser: () => ({ token: 'current' }) }]) {
    const f = webRequest({ DEV: false, MODE: 'mobile' }, nativeApp)
    await assert.rejects(f.request.get('/member/profile'), /地址|配置/)
    assert.equal(f.calls.length, 0)
  }
  const mobileDev = webRequest({ DEV: true, MODE: 'mobile' })
  await assert.rejects(mobileDev.request.get('/member/profile'), /地址|配置/)
  assert.equal(mobileDev.calls.length, 0)
})

test('独立网页调试与显式正式地址仍能请求，不产生虚构登录凭证', async () => {
  for (const [env, base] of [[{ DEV: true, MODE: 'development' }, 'http://127.0.0.1:3000'],
    [{ DEV: false, VITE_API_BASE_URL: fields.API_BASE_URL }, fields.API_BASE_URL]]) {
    const f = webRequest(env); await f.request.get('/member/profile')
    assert.equal(f.calls[0].baseURL, base); assert.equal(f.calls[0].headers.Authorization, undefined)
  }
})

test('未配置智能分流地址时不发网络请求，配置后保留原请求契约', async () => {
  const config = { DECISION_SERVICE_URL: '' }, calls = []
  const { DecisionService } = execute(sourceOf('mixed-development-h5/commons/network/src/main/ets/DecisionService.ets'), {
    constants: { GlobalVariable: config }, '@ohos/axios': { __esModule: true, default: { create: () => ({
      post: async (...args) => { calls.push(args); return { data: { result: 'logistics' } } },
    }) } },
  })
  await assert.rejects(DecisionService.routeOrderMessage('问题'), /未配置/); assert.equal(calls.length, 0)
  config.DECISION_SERVICE_URL = 'https://decision.fixture.com'
  assert.equal((await DecisionService.routeOrderMessage('问题')).result, 'logistics')
  assert.equal(calls[0][0], '/api/decision/template'); assert.equal(calls[0][1].state, '问题')
})

test('实际Vite配置拒绝移动端地址覆盖及独立正式构建的缺失或本机地址', () => {
  let env = {}
  const source = sourceOf('shoph5-vue3/vite.config.ts').replaceAll('import.meta.url', JSON.stringify(new URL('../../shoph5-vue3/vite.config.ts', import.meta.url).href))
  const { default: configure } = execute(source, {
    'node:url': { URL, fileURLToPath }, vite: { defineConfig: value => value, loadEnv: () => env },
    '@vitejs/plugin-vue': { __esModule: true, default: () => ({}) }, 'vite-plugin-singlefile': { viteSingleFile: () => ({}) },
    '../mixed-development-h5/build-support/client-environment': environment,
  })
  assert.match(configure({ mode: 'mobile', command: 'build' }).build.outDir, /rawfile/)
  assert.throws(() => configure({ mode: 'production', command: 'build' }), /VITE_API_BASE_URL/)
  env = { VITE_API_BASE_URL: 'http://127.0.0.1:3000' }
  assert.throws(() => configure({ mode: 'production', command: 'build' }), /HTTPS/)
  assert.throws(() => configure({ mode: 'mobile', command: 'build' }), /native API bridge/)
  configure({ mode: 'development', command: 'serve' })
  env = { VITE_API_BASE_URL: fields.API_BASE_URL }; configure({ mode: 'production', command: 'build' })
})

test('发布验证入口拒绝跳过网页或原生构建，不复用缺少来源检查的旧产物', () => {
  for (const flag of ['-SkipH5', '-SkipNative']) {
    const result = spawnSync('pwsh', ['-File', fileURLToPath(new URL('../verify-project.ps1', import.meta.url)), '-BuildMode', 'release', flag], { encoding: 'utf8' })
    assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /skip switches are not allowed/)
  }
})
