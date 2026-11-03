import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.cjs', timeout: 60000, workers: 1,
  reporter: 'list', use: { trace: 'retain-on-failure' },
  webServer: { command: 'npm exec vite -- --host 127.0.0.1', url: 'http://127.0.0.1:5173', reuseExistingServer: true, timeout: 30000 }
});
