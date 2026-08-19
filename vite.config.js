import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  // Relative base: the build is served from /games/billy-bob/ on zulop.net but
  // from / under `vite preview`. Relative asset URLs work under both.
  base: './',
  server: {
    host: true,
    port: 5175,
  },
  build: {
    outDir: 'dist',
    // Deliberately not `esnext`: a module the browser cannot even PARSE fails
    // silently — no error event, no console entry — and the boot screen just
    // sits there. es2022 is understood by everything that can run WebGL2.
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
})
