import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // 对接真实管理服务时，开发服务器把 /api 转发过去，例如 SINGWEB_API_PROXY=http://127.0.0.1:8787
  const proxyTarget = env.SINGWEB_API_PROXY
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: proxyTarget ? { '/api': { target: proxyTarget, changeOrigin: true } } : undefined,
    },
    build: {
      rolldownOptions: {
        output: {
          // 第三方库单独打包：应用更新后，浏览器还能继续用缓存里的库
          codeSplitting: { groups: [{ name: 'vendor', test: /node_modules/ }] },
        },
      },
    },
  }
})
