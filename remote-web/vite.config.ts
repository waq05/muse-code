import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * 产物落点：宿主 remote 插件固定从 `lib/remote/assets` 静态伺服，
 * 所以 outDir 由本文件按自身位置算出来，从任何 cwd 执行 pnpm build 都落在同一处。
 *
 * root 显式写成相对本文件的路径（而不是依赖 process.cwd()）：这样即使有人
 * 在仓库根部执行 `vite build remote-web`，产物也不会跑到别的地方去。
 */
const rootDir = fileURLToPath(new URL('.', import.meta.url))
const outDir = fileURLToPath(new URL('../lib/remote/assets', import.meta.url))
const publicDir = fileURLToPath(new URL('./public', import.meta.url))
const serviceWorkerFile = fileURLToPath(new URL('./src/sw.js', import.meta.url))

/** 本地 `pnpm dev` 时把 /api 与 /ws 转发给宿主插件（默认端口 17321）。 */
const devOrigin = process.env.DSC_REMOTE_ORIGIN ?? 'http://127.0.0.1:17321'

/**
 * 把 `src/sw.js` 原样拷成产物根下的 `sw.js`。
 *
 * 为什么不放 public/：service worker 的注册路径、作用域、通知图标都按它的 URL 算，
 * 放 src 下与它服务的界面代码挨着更好找。为什么不用 rollup 打包：SW 不能带内容哈希
 * （注册路径写死 './sw.js'），走 assetFileName 命名规则只会互相打架，原样 emit 最省事。
 */
function copyServiceWorker(): Plugin {
  return {
    name: 'dsc-remote-copy-service-worker',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: readFileSync(serviceWorkerFile, 'utf8'),
      })
    },
  }
}

/**
 * dev 下也把 `/sw.js` 指到源文件。
 *
 * 不这么做的话本地联调时注册会拿到 SPA 兜底页（HTML），浏览器直接判失败——
 * 而 localhost 恰好是安全上下文，推送与 service worker 本来可以在本地验的。
 */
function serviceWorkerDev(): Plugin {
  return {
    name: 'dsc-remote-service-worker-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if ((request.url ?? '').split('?')[0] !== '/sw.js') {
          next()
          return
        }
        response.setHeader('content-type', 'text/javascript; charset=utf-8')
        response.setHeader('cache-control', 'no-cache')
        response.end(readFileSync(serviceWorkerFile, 'utf8'))
      })
    },
  }
}

export default defineConfig({
  root: rootDir,
  // 相对路径引用资产：宿主把产物目录挂在 / 上，绝对路径也能用，
  // 但相对路径在「挂到子路径」时同样成立，容错更宽。
  base: './',
  // manifest.json 与两张图标走 public：这两个不需要打包，原样拷进产物根即可。
  publicDir,
  plugins: [react(), copyServiceWorker(), serviceWorkerDev()],
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
