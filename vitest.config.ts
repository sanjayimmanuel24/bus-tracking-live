import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@citybus/shared': resolve(import.meta.dirname, 'packages/shared/src/index.ts') },
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
