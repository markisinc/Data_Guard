import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Office add-ins must be served over HTTPS. `npm run certs` installs trusted localhost certs here.
function devCerts() {
  const dir = path.join(os.homedir(), '.office-addin-dev-certs');
  const key = path.join(dir, 'localhost.key');
  const cert = path.join(dir, 'localhost.crt');
  return fs.existsSync(key) && fs.existsSync(cert)
    ? { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
    : undefined;
}

export default defineConfig(({ command }) => ({
  // Relative paths in the build so it works under a sub-path like https://you.github.io/dataguard/.
  base: command === 'build' ? './' : '/',
  plugins: [react()],
  server: { port: 3000, strictPort: true, https: command === 'serve' ? devCerts() : undefined },
  build: { outDir: 'dist', rollupOptions: { input: { taskpane: 'taskpane.html' } } },
  test: { globals: true, include: ['tests/**/*.test.ts'] },
}));
