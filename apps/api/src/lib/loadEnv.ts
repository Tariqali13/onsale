import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load `.env` files for local development, using Node's built-in loader (no dotenv).
 *
 * Looks in `apps/api/.env` first, then the repository root `.env`, so either
 * location works. Variables already set in the real environment always win:
 * `process.loadEnvFile` never overwrites them, which keeps hosted deploys
 * (Render, Docker, CI) driven purely by their own configuration.
 */
export function loadEnvFiles(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/lib or dist/lib -> apps/api -> repo root
  const apiDir = path.resolve(here, '../..');
  const candidates = [path.join(apiDir, '.env'), path.resolve(apiDir, '../../.env')];
  const loaded: string[] = [];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    process.loadEnvFile(file);
    loaded.push(file);
  }
  return loaded;
}
