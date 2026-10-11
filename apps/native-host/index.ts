import { Archive, loadConfig } from './archive.ts';
import { encodeFrame, FrameDecoder } from './framing.ts';
import { PROTOCOL_VERSION, type HostRequest } from '../../packages/shared/model.ts';
import { BatchAssembler } from './chunks.ts';

async function main(): Promise<void> {
  const configIndex = process.argv.indexOf('--config');
  if (configIndex < 0 || !process.argv[configIndex + 1]) throw new Error('Host configuration is required');
  const config = await loadConfig(process.argv[configIndex + 1]);
  if (!process.argv.includes(`chrome-extension://${config.extensionId}/`)) throw new Error('Caller extension origin is not allowed');
  const archive = await Archive.create(config.archiveRoot);
  const assembler = new BatchAssembler();
  const decoder = new FrameDecoder(); process.stdin.pipe(decoder);
  const reply = async (value: unknown): Promise<void> => {
    const frame = encodeFrame(value);
    if (!process.stdout.write(frame)) await new Promise<void>(resolve => process.stdout.once('drain', resolve));
  };
  try {
    for await (const input of decoder) {
      const request = input as HostRequest;
      try {
        if (!request || typeof request.id !== 'string' || request.id.length > 128 || typeof request.op !== 'string') throw new Error('Invalid request envelope');
        const payload = (request.payload ?? {}) as Record<string, unknown>;
        let result: unknown;
        switch (request.op) {
          case 'hello': result = { protocol: PROTOCOL_VERSION, version: '0.3.0', archiveRoot: archive.root, textOnly: config.textOnly }; break;
          case 'capture': result = archive.capture(payload as never); break;
          case 'captureChunk': { const batch = assembler.accept(payload); result = batch ? { complete: true, ...archive.capture(batch) } : { complete: false }; break; }
          case 'stats': result = archive.stats(); break;
          case 'conversations': result = archive.conversations(Number(payload.offset) || 0, typeof payload.jobId === 'string' ? payload.jobId : undefined); break;
          case 'createJob': result = archive.createJob(payload as never); break;
          case 'job': result = archive.job(typeof payload.jobId === 'string' ? payload.jobId : undefined); break;
          case 'updateJob': result = archive.updateJob(String(payload.jobId), payload as never); break;
          case 'saveCustomers': result = archive.saveCustomers(String(payload.jobId), payload.customers as never, payload.frozen === true); break;
          case 'jobCustomers': result = archive.jobCustomers(String(payload.jobId), Number(payload.offset) || 0); break;
          case 'updateCustomer': result = archive.updateCustomer(String(payload.jobId), String(payload.customerId), payload as never); break;
          case 'historyInfo': result = archive.historyInfo(String(payload.projectId), String(payload.customerId), String(payload.from), String(payload.until), (payload.ids ?? []) as string[]); break;
          case 'media': result = archive.pendingMedia(payload.retry === true); break;
          case 'retryMedia': result = archive.retryMedia(); break;
          case 'planDownload': result = archive.planDownload(String(payload.assetId)); break;
          case 'bindDownload': result = archive.bindDownload(String(payload.jobId), Number(payload.downloadId)); break;
          case 'importDownload': result = await archive.importDownload(String(payload.jobId), Number(payload.downloadId), String(payload.filename)); break;
          case 'failDownload': result = archive.failDownload(String(payload.jobId), String(payload.error)); break;
          case 'downloads': result = archive.downloads(); break;
          case 'export': result = await archive.exportConversation(String(payload.conversationId), typeof payload.jobId === 'string' ? payload.jobId : undefined); break;
          case 'exportCustomers': result = await archive.exportCustomers(typeof payload.jobId === 'string' ? payload.jobId : undefined); break;
          default: throw new Error('Unknown operation');
        }
        await reply({ id: request.id, ok: true, result });
      } catch (error) { await reply({ id: request?.id ?? '', ok: false, error: (error as Error).message }); }
    }
  } finally { archive.close(); }
}
main().catch(error => { process.stderr.write(`SaleSmartly archive host: ${(error as Error).message}\n`); process.exitCode = 1; });
