import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOST_NAME } from '../packages/shared/model.ts';

export function shellQuote(value: string): string {
  if (value.includes('\0') || value.includes('\n')) throw new Error('Native host path contains a newline');
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Chrome native messaging uses stdout for binary frames. The script must replace
// itself with node and must not print anything.
export function linuxLauncher(nodePath: string, nativeEntry: string, configPath: string): string {
  return `#!/bin/sh\nexec ${shellQuote(nodePath)} --disable-warning=ExperimentalWarning ${shellQuote(nativeEntry)} --config ${shellQuote(configPath)} "$@"\n`;
}

export function hostManifest(executablePath: string, extensionId: string): string {
  return JSON.stringify({
    name: HOST_NAME,
    description: 'SaleSmartly local chat archive',
    path: executablePath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2);
}

export function nativeHostManifestDirs(home: string, xdgConfigHome?: string): string[] {
  if (!home) throw new Error('HOME is required to register the Chrome native host');
  const config = xdgConfigHome || path.join(home, '.config');
  return ['google-chrome', 'chromium', 'google-chrome-for-testing'].map(name => path.join(config, name, 'NativeMessagingHosts'));
}

interface BuildInfo { extensionId: string; nodePath: string; nativeEntry: string; archiveRoot: string }

async function readBuildInfo(root: string): Promise<BuildInfo> {
  const file = path.join(root, 'dist/build-info.json');
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Build first: npm run build');
    throw error;
  }
  const extensionId = parsed.extensionId;
  const nodePath = parsed.nodePath;
  const nativeEntry = parsed.nativeEntry;
  const archiveRoot = parsed.archiveRoot;
  if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) throw new Error('Invalid extension id in build info');
  for (const [label, value] of [['node', nodePath], ['native entry', nativeEntry], ['archive root', archiveRoot]] as const) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`Invalid ${label} path in build info`);
  }
  return { extensionId, nodePath: nodePath as string, nativeEntry: nativeEntry as string, archiveRoot: archiveRoot as string };
}

async function setupLinux(root: string, register: boolean, unregister: boolean, textOnly: boolean): Promise<void> {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME is required to register the Chrome native host');
  const installed = nativeHostManifestDirs(home, process.env.XDG_CONFIG_HOME).map(directory => path.join(directory, `${HOST_NAME}.json`));
  if (unregister) {
    await Promise.all(installed.map(filename => rm(filename, { force: true })));
    console.log('Native host registration removed. Archive files were retained.');
    return;
  }
  const info = await readBuildInfo(root);
  const nativeDirectory = path.join(root, '.local/native');
  await mkdir(nativeDirectory, { recursive: true });
  const configPath = path.join(nativeDirectory, 'config.json');
  const executablePath = path.join(nativeDirectory, 'salesmartly-native');
  await writeFile(configPath, JSON.stringify({ archiveRoot: info.archiveRoot, extensionId: info.extensionId, textOnly }, null, 2));
  await writeFile(executablePath, linuxLauncher(info.nodePath, info.nativeEntry, configPath), { mode: 0o755 });
  await chmod(executablePath, 0o755);
  const manifest = hostManifest(executablePath, info.extensionId);
  const manifestPath = path.join(nativeDirectory, `${HOST_NAME}.json`);
  await writeFile(manifestPath, manifest);
  if (register) {
    for (const filename of installed) {
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, manifest);
    }
    console.log('Registered the native host for Chrome, Chromium, and Chrome for Testing.');
  }
  console.log(`Native manifest: ${manifestPath}`);
  console.log(`Extension ID: ${info.extensionId}`);
  console.log(`Text only: ${textOnly}`);
  console.log(`Load unpacked in the browser: ${path.join(root, 'dist/extension')}`);
}

function setupWindows(root: string, register: boolean, unregister: boolean): void {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools/setup-native.ps1')];
  if (register) args.push('-Register');
  if (unregister) args.push('-Unregister');
  const child = spawnSync('powershell', args, { stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

async function main(): Promise<void> {
  const register = process.argv.includes('--register');
  const unregister = process.argv.includes('--unregister');
  const textOnly = process.argv.includes('--text-only');
  if (register && unregister) throw new Error('Choose either --register or --unregister');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (process.platform === 'win32') {
    if (textOnly) throw new Error('On Windows set chrome.storage.local textOnly instead of --text-only');
    setupWindows(root, register, unregister);
    return;
  }
  if (process.platform !== 'linux') throw new Error(`Native host setup is not implemented for ${process.platform}`);
  await setupLinux(root, register, unregister, textOnly);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main().catch(error => { console.error((error as Error).message); process.exit(1); });
}
