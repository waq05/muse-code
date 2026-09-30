import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 产物落点：宿主 remote 插件固定从 `lib/remote/assets` 静态伺服，
 * 所以 outDir 由本文件按自身位置算出来，从任何 cwd 执行 pnpm build 都落在同一处。
 *
 * root 显式写成相对本文件的路径（而不是依赖 process.cwd()）：这样即使有人
 * 在仓库根部执行 `vite build remote-web`，产物也不会跑到别的地方去。
 */
const rootDir = fileURLToPath(new URL('.', import.meta.url))
const outDir = fileURLToPath(new URL('../lib/remote/assets', import.meta.url))

/** 本地 `pnpm dev` 时把 /api 与 /ws 转发给宿主插件（默认端口 17321）。 */
const devOrigin = process.env.DSC_REMOTE_ORIGIN ?? 'http://127.0.0.1:17321'

export default defineConfig({
  root: rootDir,
  // 相对路径引用资产：宿主把产物目录挂在 / 上，绝对路径也能用，
  // 但相对路径在「挂到子路径」时同样成立，容错更宽。
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5273,
    proxy: {
      '/api': { target: devOrigin, changeOrigin: true },
      '/ws': { target: devOrigin, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir,
    // outDir 在 root 之外，必须显式声明才允许清空（否则 vite 会拒绝写入）。
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: false,
    // 资产直接放在产物目录根部：宿主按文件名伺服 /assets/*，
    // 少一层目录就少一处「路径对不上」的可能。
    assetsDir: '',
    rollupOptions: {
      output: {
        entryFileNames: 'app-[hash].js',
        chunkFileNames: 'chunk-[hash].js',
        assetFileNames: '[name]-[hash][extname]',
      },
    },
  },
})
