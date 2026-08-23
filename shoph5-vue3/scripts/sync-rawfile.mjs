import { copyFile, mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../dist/index.html', import.meta.url))
const targetDirectory = fileURLToPath(new URL('../../mixed-development-h5/features/mine/src/main/resources/rawfile/', import.meta.url))
const target = fileURLToPath(new URL('../../mixed-development-h5/features/mine/src/main/resources/rawfile/index.html', import.meta.url))

await stat(source)
await mkdir(targetDirectory, { recursive: true })
await copyFile(source, target)
