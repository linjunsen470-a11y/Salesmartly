import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { generateKeyPairSync, createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const local = path.join(root, '.local'); await mkdir(local, { recursive: true });
const keyFile = path.join(local, 'extension-public-key.json');
let key;
try { key = JSON.parse(await readFile(keyFile, 'utf8')).key; }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  await writeFile(keyFile, JSON.stringify({ key }, null, 2));
}
const extensionId = [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)].flatMap(byte => [String.fromCharCode(97 + (byte >> 4)), String.fromCharCode(97 + (byte & 15))]).join('');
const extensionDir = path.join(root, 'dist/extension'), nativeDir = path.join(root, 'dist/native');
await mkdir(extensionDir, { recursive: true }); await mkdir(nativeDir, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['apps/extension/worker.ts', 'apps/extension/panel.ts'], outdir: extensionDir, bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', sourcemap: false });
await build({ absWorkingDir: root, entryPoints: ['apps/extension/content.ts'], outfile: path.join(extensionDir, 'content.js'), bundle: true, format: 'iife', platform: 'browser', target: 'chrome120' });
for (const name of ['observer', 'proxy', 'observer-stop', 'driver']) await build({ absWorkingDir: root, entryPoints: [`apps/extension/${name}.ts`], outfile: path.join(extensionDir, `${name}.js`), bundle: true, format: 'iife', platform: 'browser', target: 'chrome120' });
await build({ absWorkingDir: root, entryPoints: ['apps/native-host/index.ts'], outfile: path.join(nativeDir, 'native-host.cjs'), bundle: true, format: 'cjs', platform: 'node', target: 'node24', external: ['node:sqlite'] });
for (const filename of ['panel.html', 'panel.css']) await copyFile(path.join(root, 'apps/extension', filename), path.join(extensionDir, filename));
await writeFile(path.join(extensionDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'SaleSmartly 本地归档', description: '批量加载筛选客户的聊天历史，增量保存消息和媒体到本机。', version: '0.3.0', key, minimum_chrome_version: '120', permissions: ['debugger', 'nativeMessaging', 'downloads', 'storage', 'alarms', 'scripting'], host_permissions: ['https://app.salesmartly.com/*'], background: { service_worker: 'worker.js', type: 'module' }, action: { default_title: '打开 SaleSmartly 本地归档' }, content_scripts: [{ matches: ['https://app.salesmartly.com/next/chat*'], js: ['proxy.js'], run_at: 'document_start', all_frames: true }, { matches: ['https://app.salesmartly.com/next/chat*'], js: ['observer.js'], run_at: 'document_start', world: 'MAIN', all_frames: true }], content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'" } }, null, 2));
await writeFile(path.join(root, 'dist/build-info.json'), JSON.stringify({ extensionId, extensionDir, nodePath: process.execPath, nativeEntry: path.join(nativeDir, 'native-host.cjs'), archiveRoot: path.join(root, '.local/archive') }, null, 2));
console.log(`Build complete\nExtension ID: ${extensionId}\nLoad unpacked: ${extensionDir}`);
