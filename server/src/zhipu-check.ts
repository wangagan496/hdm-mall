import { readConfig } from './config.ts'
import { ZHIPU_MODEL } from './zhipu-chat.ts'

try {
  if (readConfig(process.env).appOptions.promiseDriver?.model !== ZHIPU_MODEL) throw new Error('Zhipu is not configured')
  console.log(`智谱已配置（${ZHIPU_MODEL}），本次未发送模型请求`)
} catch {
  console.error('无法读取有效的智谱配置，请检查密钥及其文件路径')
  process.exitCode = 1
}
