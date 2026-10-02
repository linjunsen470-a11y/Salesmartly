import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Archive } from '../apps/native-host/archive.ts';
import { batch, message, png, wav } from '../tests/fixtures.ts';
const store = await Archive.create(path.resolve('.local/demo/archive'));
try {
  store.capture(batch([
    message({ text: '这是合成演示会话，不包含真实客户数据。\n图片、语音与视频会保存在本地。', sender: '演示客户' }),
    message({ sourceId: 'demo-image', type: '2', text: '图片示例', attachments: [{ slot: '0', kind: 'image', url: 'https://example.invalid/demo.png', filename: '演示图片.png' }] }),
    message({ sourceId: 'demo-audio', type: '12', text: '一秒演示音频', attachments: [{ slot: '0', kind: 'audio', url: 'https://example.invalid/demo.wav', filename: '演示语音.wav' }] }),
    message({ sourceId: 'demo-video', type: '6', text: '未下载的视频会明确提示缺失', attachments: [{ slot: '0', kind: 'video', url: 'https://example.invalid/demo.mp4', filename: '演示视频.mp4' }] }),
    message({ sourceId: 'demo-reply', text: '收到，离线档案已生成。', sender: '演示客服', direction: 'outgoing' }),
  ], 'demo-initial'));
  for (const asset of store.pendingMedia()) {
    let bytes: Buffer;
    if (asset.kind === 'image') bytes = png;
    else if (asset.kind === 'audio') bytes = wav();
    else {
      try { bytes = await readFile(path.resolve('.local/demo-video.mp4')); }
      catch { continue; }
    }
    const plan = store.planDownload(asset.id), filename = path.join(store.root, 'staging', plan.suffix);
    store.bindDownload(plan.jobId, 1); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes); await store.importDownload(plan.jobId, 1, filename);
  }
  const id = (store.conversations() as { id: string }[])[0].id;
  const exported = await store.exportConversation(id);
  await writeFile(path.resolve('.local/demo-result.json'), JSON.stringify(exported, null, 2));
  console.log(JSON.stringify({ demo: true, ...exported }, null, 2));
} finally { store.close(); }
