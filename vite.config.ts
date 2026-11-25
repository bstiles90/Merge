import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // "1.0.0" (stable), "Beta abc1234" (CI builds) or "dev"
  define: { __MERGE_VERSION__: JSON.stringify(process.env.MERGE_VERSION || 'dev') },
  base: './', // relative asset paths: the built console is served from inside the Merge app
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
} as any);
