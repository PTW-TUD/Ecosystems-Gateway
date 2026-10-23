import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.spec.ts'] },
      },
      {
        extends: true,
        test: { name: 'e2e', include: ['test/**/*.e2e-spec.ts'] },
      },
    ],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/**/*.spec.ts'],
    },
  },
});
