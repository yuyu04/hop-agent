import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

type OverrideStrategy = 'extension' | 'fork' | 'contribution';

interface OverrideEntry {
  id: string;
  strategy: OverrideStrategy;
  reason: string;
}

interface OverrideManifest {
  schemaVersion: number;
  overrides: OverrideEntry[];
}

const manifestUrl = new URL('../../config/rhwp-studio-overrides.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as OverrideManifest;

validateManifest(manifest);

export const hopOverrides = manifest.overrides;

export function createHopOverrides(hopSrc: string) {
  return hopOverrides.map(({ id }) => ({
    find: `@/${id}`,
    replacement: resolve(hopSrc, id),
  }));
}

function validateManifest(candidate: OverrideManifest): void {
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.overrides)) {
    throw new Error('Unsupported rhwp studio override manifest');
  }
  const ids = new Set<string>();
  for (const entry of candidate.overrides) {
    if (!entry.id || ids.has(entry.id)) throw new Error(`Invalid or duplicate HOP override: ${entry.id}`);
    const segments = entry.id.split(/[\\/]+/);
    const isForeignAbsolutePath = /^[A-Za-z]:[\\/]/.test(entry.id) || /^[\\/]{2}/.test(entry.id);
    if (isAbsolute(entry.id) || isForeignAbsolutePath || segments.includes('..')) {
      throw new Error(`HOP override escapes the source root: ${entry.id}`);
    }
    if (!['extension', 'fork', 'contribution'].includes(entry.strategy)) {
      throw new Error(`Invalid strategy for HOP override: ${entry.id}`);
    }
    if (!entry.reason.trim()) throw new Error(`Missing reason for HOP override: ${entry.id}`);
    ids.add(entry.id);
  }
}
