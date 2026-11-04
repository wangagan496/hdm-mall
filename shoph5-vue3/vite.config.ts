import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { validateServiceUrl } from '../mixed-development-h5/build-support/client-environment'

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_')
  if (mode === 'mobile') {
    if (env.VITE_API_BASE_URL) throw new Error('Mobile H5 must use the native API bridge; remove VITE_API_BASE_URL')
  } else if (command === 'build' || env.VITE_API_BASE_URL) {
    validateServiceUrl(env.VITE_API_BASE_URL || '', 'VITE_API_BASE_URL', command === 'build')
  }
  return {
    base: './',
    plugins: [vue(), viteSingleFile({ removeViteModuleLoader: true })],
    build: mode === 'mobile' ? {
      outDir: fileURLToPath(new URL('../mixed-development-h5/features/mine/src/main/resources/rawfile', import.meta.url)),
      emptyOutDir: false,
    } : undefined,
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  }
})
