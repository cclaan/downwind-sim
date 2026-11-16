import { defineConfig } from 'vite'

// The Hood River level is a stand-alone app. It builds into ./dist (never into the
// site's static folder) and uses relative asset paths so it can be hosted anywhere.
export default defineConfig({
  base: './',
  server: { port: 5183, strictPort: false, host: true },
  preview: { port: 5184 },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  // three and lil-gui are plain ES modules: serve them as they are, so several dev
  // servers (the capture tool starts its own) never race on a shared pre-bundle cache
  optimizeDeps: { noDiscovery: true, include: [] },
})
