import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

// Match setup-bun's artifact selection. A Linux x64 baseline executable must
// not share a cache with an AVX2 executable, even when the Bun version matches.
export function bunCacheTarget({ version, platform, arch, home, cpuInfo = '' }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Bun executable caches require a pinned release version.');
  }
  if (!['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported Bun cache target: ${platform}/${arch}`);
  }

  const os = platform === 'win32' ? 'windows' : platform;
  const artifactArch = arch === 'arm64' ? 'aarch64' : arch;
  const baseline = platform === 'linux' && arch === 'x64' && !cpuInfo.includes('avx2');
  const paths = platform === 'win32' ? win32 : posix;
  return {
    key: `bun-executable-v1-${version}-${os}-${artifactArch}${baseline ? '-baseline' : ''}`,
    path: paths.join(home, '.bun', 'bin', platform === 'win32' ? 'bun.exe' : 'bun'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let cpuInfo = '';
  if (process.platform === 'linux' && process.arch === 'x64') {
    try {
      cpuInfo = readFileSync('/proc/cpuinfo', 'utf8');
    } catch {
      // setup-bun also falls back to the baseline artifact if detection fails.
      console.warn('Unable to detect AVX2; using the baseline Bun cache.');
    }
  }
  const target = bunCacheTarget({
    version: process.argv[2],
    platform: process.platform,
    arch: process.arch,
    home: homedir(),
    cpuInfo,
  });
  const output = `key=${target.key}\npath=${target.path}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}
