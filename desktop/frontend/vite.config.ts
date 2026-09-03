/// <reference types="vitest/config" />
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

// Tauri dev/build wiring:
// - devUrl in ../src-tauri/tauri.conf.json points at http://localhost:5173
//   (strictPort keeps that promise or fails loudly).
// - build output goes to ./dist, which tauri.conf.json's frontendDist
//   (../frontend/dist) embeds at compile time.
const isWindows = process.env.TAURI_ENV_PLATFORM === 'windows';

export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
      $tests: fileURLToPath(new URL('./src/tests', import.meta.url)),
    },
    // Under vitest, compile Svelte components for the client (jsdom), not
    // the server, so `mount(...)` works in component tests. Outside tests
    // leave conditions untouched (Vite's client defaults apply).
    ...(mode === 'test' ? { conditions: ['browser'] } : {}),
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Tauri 2 webviews: WKWebView on macOS/Linux webkitgtk, WebView2 on Windows.
    target: isWindows ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : true,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
}));
