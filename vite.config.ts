import { defineConfig } from 'vite'

export default defineConfig({
  base: '/downwind-sim/',
  build: {
    outDir: '../static/downwind-sim',
    emptyOutDir: true,
  },
})
