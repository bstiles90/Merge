import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // relative asset paths: the built console is served from inside the Merge app
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
} as any);
