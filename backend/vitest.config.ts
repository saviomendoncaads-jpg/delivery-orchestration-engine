import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // msnodesqlv8/mssql são bindings nativos: mantém como external (sem transform do Vite).
    server: { deps: { external: [/msnodesqlv8/, /^mssql/] } },
  },
});
