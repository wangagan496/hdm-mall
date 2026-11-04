// 保留旧命令入口，但重新检查并构建源码，绝不从旧 dist 覆盖手机资源。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const npm = process.env.npm_execpath
if (!npm) throw new Error('请使用 pnpm run sync:rawfile；该命令现在重新执行移动端构建')
const result = spawnSync(process.execPath, [npm, 'run', 'build:mobile'], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
