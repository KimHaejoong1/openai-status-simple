import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version)) throw new Error('Invalid Chrome extension version.');
  const parts = version.split('.').map(Number);
  if (parts.some(part => part > 65535) || parts.every(part => part === 0)) throw new Error('Chrome version components must be 0..65535 and not all zero.');
  return [...parts, ...Array(4 - parts.length).fill(0)];
}

export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

export function validateRelease(manifest, pkg, tag = '') {
  versionParts(manifest.version);
  if (manifest.manifest_version !== 3) throw new Error('Expected a Manifest V3 extension.');
  if (manifest.version !== pkg.version) throw new Error('manifest.json and package.json versions must match.');
  if (tag && (!/^v\d+\.\d+\.\d+$/.test(tag) || tag !== `v${manifest.version}`)) throw new Error('Release tag must be vX.Y.Z and match manifest.json exactly.');
  return manifest.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = new URL('../', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    const version = validateRelease(manifest, pkg, process.env.RELEASE_TAG);
    console.log(`Validated extension version ${version}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
