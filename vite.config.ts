import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'

const packageInfo = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
const buildTime = new Date().toISOString()

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(packageInfo.version),
    __APP_BUILD_TIME__: JSON.stringify(buildTime),
  },
  server: { strictPort: true },
  build: { target: 'es2022' },
})
