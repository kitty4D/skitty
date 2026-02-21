import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import vercel from 'vite-plugin-vercel';

export default defineConfig({
  plugins: [react(), vercel()],
  optimizeDeps: {
    include: ['react', 'react-dom', '@mysten/dapp-kit'],
  },
  vercel: {
    rewrites: [
      {
        source: '/(.*)',
        destination: '/index.html',
      },
    ],
  },
});
