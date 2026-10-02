import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * dsc-desktop 构建配置（electron-vite 5）。
 * main/preload 入口显式声明（布局为 electron/{main,preload}）；
 * renderer 用 dsc 根目录的编译产物（../lib）作为源，alias `@dsc/runtime`
 * 指向它——dev 直接引用源仓库，打包时经 extraResources 携带
 * （见 scripts/prepare-runtime.mjs 与 electron-builder.yml）。
 */
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve('electron/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('electron/preload/index.ts') },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      // out/renderer 在工程根之外，electron-vite/vite 默认不清空——不清的话旧的
      // 内容哈希包会越积越多，trace-check/fold-check 这类「取目录里第一个产物」的
      // 探针就会读到上上个构建的 bundle，报出与源码对不上的假失败。
      emptyOutDir: true,
    },
    resolve: {
      alias: {
        '@dsc/runtime': fileURLToPath(new URL('../lib', import.meta.url)),
      },
    },
  },
})
