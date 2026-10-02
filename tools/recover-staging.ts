import { Archive } from '../apps/native-host/archive.ts';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
const stagingRoot = path.resolve(process.argv[2] ?? 'C:/Users/lin/Downloads/SaleSmartlyArchive');
const archive = await Archive.create(path.resolve('.local/archive'));
try {
  const jobs = archive.db.prepare("SELECT * FROM downloads WHERE state='failed' AND error='Download path does not match the registered staging path'").all();
  for (const job of jobs) {
    if (!/^[a-f0-9-]{36}$/.test(String(job.job_id)) || !/^[a-f0-9]{64}$/.test(String(job.asset_id))) throw new Error('Invalid recorded staging identity');
    const directory = path.join(stagingRoot, String(job.job_id));
    const relative = path.relative(stagingRoot, directory); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Staging directory is outside task root');
    const files = (await readdir(directory)).filter(name => name.startsWith(String(job.asset_id) + '.'));
    if (files.length !== 1) continue;
    archive.db.prepare("UPDATE downloads SET state='bound' WHERE job_id=?").run(job.job_id);
    try { console.log(JSON.stringify(await archive.importDownload(String(job.job_id), Number(job.download_id), path.join(directory, files[0])))); }
    catch (error) { archive.failDownload(String(job.job_id), (error as Error).message); throw error; }
  }
} finally { archive.close(); }
