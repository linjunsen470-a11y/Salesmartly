import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { encodeFrame, FrameDecoder } from '../apps/native-host/framing.ts';
import { batch } from '../tests/fixtures.ts';
const info = JSON.parse(await readFile('.local/native/config.json', 'utf8'));
const nativeDirectory = path.resolve('.local/smoke-native');
await mkdir(nativeDirectory, { recursive: true });
await copyFile(path.resolve('.local/native/salesmartly-native.exe'), path.join(nativeDirectory, 'salesmartly-native.exe'));
const temporaryConfig = path.join(nativeDirectory, 'smoke-config.json');
await mkdir('.local/smoke-archive', { recursive: true });
await writeFile(temporaryConfig, JSON.stringify({ ...info, archiveRoot: path.resolve('.local/smoke-archive') }));
// A separate executable directory keeps production host configuration untouched.
const launcherConfigPath = path.join(nativeDirectory, 'launcher.json');
const launcherConfig = JSON.parse(await readFile('.local/native/launcher.json', 'utf8')); launcherConfig.configPath = temporaryConfig;
await writeFile(launcherConfigPath, JSON.stringify(launcherConfig));
try {
  const child = spawn(path.join(nativeDirectory, 'salesmartly-native.exe'), [`chrome-extension://${info.extensionId}/`], { windowsHide: true, stdio: 'pipe' });
  const replies: any[] = []; let stderr = '';
  const decoder = new FrameDecoder(); child.stdout.pipe(decoder); decoder.on('data', value => replies.push(value));
  child.stderr.on('data', value => stderr += value.toString());
  const exit = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); decoder.on('error', reject); });
  const timer = setTimeout(() => child.kill(), 20_000);
  const firstReply = new Promise<void>(resolve => decoder.on('data', value => { if (value.id === 'hello') resolve(); }));
  child.stdin.write(encodeFrame({ id: 'hello', op: 'hello' }));
  await firstReply; // Must reply while stdin remains open, like Chrome connectNative.
  const encoded = Buffer.concat([encodeFrame({ id: 'capture', op: 'capture', payload: batch() }), encodeFrame({ id: 'duplicate', op: 'capture', payload: batch() }), encodeFrame({ id: 'job', op: 'createJob', payload: { mode: 'count', from: '', until: new Date().toISOString(), count: 20, customerLimit: 2, scope: { view: 'fixture', status: 'all', search: '', filters: '' } } }), encodeFrame({ id: 'stats', op: 'stats' })]);
  child.stdin.write(encoded.subarray(0, 7)); child.stdin.end(encoded.subarray(7));
  const code = await exit; clearTimeout(timer);
  assert.equal(code, 0, stderr); assert.equal(replies.length, 5, stderr); assert.ok(replies.every(value => value.ok)); assert.equal(replies[0].result.version, '0.3.0'); assert.equal(replies[2].result.duplicate, true); assert.equal(replies[3].result.options.customerLimit, 2); assert.equal(replies[4].result.messages, 1);
  console.log('Native executable + framed protocol + SQLite ACK: PASS');
} finally { /* Keep isolated smoke artifacts for inspection. */ }
