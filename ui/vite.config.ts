import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// The `ui` plugin serves `dist/`. In development, `pnpm dev:ui` runs Vite on
// 5173 and proxies the API to the kernel, so the Svelte app hot-reloads while
// the plugin tree keeps running.
export default defineConfig({
  plugins: [svelte()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:5883',
      '/ws': { target: 'ws://127.0.0.1:5883', ws: true },
    },
  },
})
