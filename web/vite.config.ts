import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Firebase is by far the largest dependency; splitting it keeps the app
        // chunk small enough to stay snappy on a phone with one bar of signal.
        manualChunks: {
          firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/functions', 'firebase/storage'],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});
