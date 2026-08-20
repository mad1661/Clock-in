import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Stamped into the bundle so a problem report says which build the phone was
// actually running. A worker on a service-worker-cached copy from three deploys
// ago produces bugs nobody can reproduce, and this is what makes that visible.
const buildId = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
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
