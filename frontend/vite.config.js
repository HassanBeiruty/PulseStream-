import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/health': 'http://localhost:3000',
    },
    fs: {
      // The isomorphic core lives outside the frontend root (../shared) so the
      // Node server can import the same modules; let the dev server read it.
      allow: ['..'],
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true, // cleans the server/public folder before writing build assets
  },
});
