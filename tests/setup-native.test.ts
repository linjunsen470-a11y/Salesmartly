import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { HOST_NAME } from '../packages/shared/model.ts';
import { hostManifest, linuxLauncher, nativeHostManifestDirs } from '../tools/setup-native.ts';

test('linux launcher replaces the shell and forwards the extension origin', () => {
  const script = linuxLauncher('/usr/bin/node', '/work/dist/native/native-host.cjs', "/work/O'Brien/.local/native/config.json");
  assert.equal(script, "#!/bin/sh\nexec '/usr/bin/node' --disable-warning=ExperimentalWarning '/work/dist/native/native-host.cjs' --config '/work/O'\\''Brien/.local/native/config.json' \"$@\"\n");
});

test('native host manifest is bound to one extension', () => {
  const extensionId = 'abcdefghijklmnop'.repeat(2);
  const manifest = JSON.parse(hostManifest('/work/.local/native/salesmartly-native', extensionId));
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path, '/work/.local/native/salesmartly-native');
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
});

test('linux registration covers the browsers that can load this extension', () => {
  const dirs = nativeHostManifestDirs('/home/archive', '/home/archive/.config');
  assert.deepEqual(dirs, [
    path.join('/home/archive/.config', 'google-chrome', 'NativeMessagingHosts'),
    path.join('/home/archive/.config', 'chromium', 'NativeMessagingHosts'),
    path.join('/home/archive/.config', 'google-chrome-for-testing', 'NativeMessagingHosts'),
  ]);
});
