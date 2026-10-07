import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  artifactMetadata,
  assertStableTag,
  cargoPatchTomlPattern,
  cargoLockHasPatchSource,
  cargoLockPackageVersion,
  normalizeGitSource,
  parsePackageVersion,
  parseRustToolchain,
  parseUpdateTag,
  repoRelativePath,
  synchronizeCargoPatchToml,
  tomlSection,
  vendoredArtifactNames,
} from '../scripts/lib/rhwp-upstream.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('accepts only explicit stable semantic-version tags', () => {
  assert.doesNotThrow(() => assertStableTag('v0.7.19'));
  for (const ref of ['main', 'devel', '0.7.19', 'v0.7.19-rc.1', '']) {
    assert.throws(() => assertStableTag(ref), /stable release tag/);
  }
});

test('parses one update tag with or without pnpm argument separator', () => {
  assert.equal(parseUpdateTag(['v0.7.19']), 'v0.7.19');
  assert.equal(parseUpdateTag(['--', 'v0.7.19']), 'v0.7.19');
  for (const args of [[], ['--'], ['--skip-wasm'], ['v0.7.19', 'v0.7.18']]) {
    assert.equal(parseUpdateTag(args), null);
  }
});

test('normalizes supported Git remote spellings to one provenance source', () => {
  for (const source of [
    'https://github.com/edwardkim/rhwp.git',
    'git@github.com:edwardkim/rhwp.git',
    'ssh://git@github.com/edwardkim/rhwp.git',
  ]) {
    assert.equal(normalizeGitSource(source), 'https://github.com/edwardkim/rhwp');
  }
});

test('reads upstream Cargo and toolchain metadata without depending on formatting order', () => {
  assert.equal(parsePackageVersion('[package]\nname = "rhwp"\nversion = "1.2.3"\n'), '1.2.3');
  assert.equal(parseRustToolchain('[toolchain]\nprofile = "minimal"\nchannel = "1.93.1"\n'), '1.93.1');
  assert.equal(
    cargoLockPackageVersion('[[package]]\nname = "rhwp"\nversion = "0.7.19"\n', 'rhwp'),
    '0.7.19',
  );
});

test('reads only the requested TOML section', () => {
  const toml = '[patch.crates-io]\nfoo = "one"\n\n[dependencies]\nsvg2pdf = "0.13"\n';
  assert.equal(tomlSection(toml, 'patch.crates-io').trim(), 'foo = "one"');
  assert.doesNotMatch(tomlSection(toml, 'patch.crates-io'), /svg2pdf/);
});

test('formats repository-relative paths for git pathspecs', () => {
  assert.equal(repoRelativePath(join(repoRoot, 'apps/desktop/src-tauri')), 'apps/desktop/src-tauri');
});

test('computes artifact provenance from bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hop-rhwp-provenance-'));
  try {
    const path = join(directory, 'artifact.bin');
    await writeFile(path, 'rhwp');
    assert.deepEqual(await artifactMetadata(path), {
      bytes: 4,
      sha256: 'e33fa4cffc6af4b900b8cf538ffa7388fcb9978ebd76a009f83a83114b0ffb07',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('requires the exact Cargo patch repository and revision independent of TOML field order', () => {
  const patch = {
    git: 'https://github.com/planet6897/svg2pdf',
    rev: '2caeb0a038f9128b79833d803b94c2667565c4da',
  };
  const tomlPattern = cargoPatchTomlPattern('svg2pdf', patch);
  assert.match(
    'svg2pdf = { rev = "2caeb0a038f9128b79833d803b94c2667565c4da", git = "https://github.com/planet6897/svg2pdf" }',
    tomlPattern,
  );
  assert.doesNotMatch(
    'svg2pdf = { git = "https://example.com/svg2pdf", rev = "2caeb0a038f9128b79833d803b94c2667565c4da" }',
    tomlPattern,
  );
  assert.doesNotMatch(
    '# svg2pdf = { git = "https://github.com/planet6897/svg2pdf", rev = "2caeb0a038f9128b79833d803b94c2667565c4da" }',
    tomlPattern,
  );
  assert.equal(
    cargoLockHasPatchSource(
      '[[package]]\nname = "svg2pdf"\nversion = "0.13.0"\nsource = "git+https://github.com/planet6897/svg2pdf?rev=x#2caeb0a038f9128b79833d803b94c2667565c4da"',
      'svg2pdf',
      patch,
    ),
    true,
  );
});

test('synchronizes Cargo patch sources as one upstream contract transition', () => {
  const previous = {
    svg2pdf: { git: 'https://github.com/old/svg2pdf', rev: '1111111111111111111111111111111111111111' },
  };
  const next = {
    svg2pdf: { git: 'https://github.com/new/svg2pdf', rev: '2222222222222222222222222222222222222222' },
  };
  const cargoToml = '[patch.crates-io]\nsvg2pdf = { rev = "1111111111111111111111111111111111111111", git = "https://github.com/old/svg2pdf" }\n';
  assert.equal(
    synchronizeCargoPatchToml(cargoToml, previous, next),
    '[patch.crates-io]\nsvg2pdf = { git = "https://github.com/new/svg2pdf", rev = "2222222222222222222222222222222222222222" }\n',
  );
  assert.throws(
    () => synchronizeCargoPatchToml(cargoToml, next, previous),
    /does not match the current upstream contract/,
  );

  const dependencyAndPatch = [
    '[dependencies]',
    'svg2pdf = { git = "https://github.com/dependency/svg2pdf", rev = "3333333333333333333333333333333333333333" }',
    '',
    cargoToml.trimEnd(),
    '',
  ].join('\n');
  const synchronized = synchronizeCargoPatchToml(dependencyAndPatch, previous, next);
  assert.match(
    tomlSection(synchronized, 'dependencies'),
    /https:\/\/github\.com\/dependency\/svg2pdf/,
  );
  assert.match(
    tomlSection(synchronized, 'patch.crates-io'),
    /https:\/\/github\.com\/new\/svg2pdf/,
  );
});

test('provenance covers every shipped vendored file', () => {
  assert.deepEqual(vendoredArtifactNames, [
    'rhwp_bg.wasm',
    'rhwp.js',
    'rhwp.d.ts',
    'rhwp_bg.wasm.d.ts',
    'package.json',
    'LICENSE',
  ]);
});

test('update command refuses missing, moving, or malformed refs before changing the checkout', () => {
  const before = git(['-C', 'third_party/rhwp', 'rev-parse', 'HEAD']).stdout.trim();
  for (const args of [[], ['main'], ['v0.7.19', '--skip-wasm'], ['v0.7.19', 'v0.7.18']]) {
    const result = spawnSync(process.execPath, ['scripts/update-rhwp-upstream.mjs', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
  }
  const after = git(['-C', 'third_party/rhwp', 'rev-parse', 'HEAD']).stdout.trim();
  assert.equal(after, before);
});

test('legacy shell entrypoint requires UPSTREAM_REF', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync('bash', ['scripts/update-upstream.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, UPSTREAM_REF: '' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /UPSTREAM_REF is required/);
});

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
