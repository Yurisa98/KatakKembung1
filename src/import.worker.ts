import { importWorkbook } from './importer';

self.onmessage = async ({ data }: MessageEvent<{ name: string; bytes: ArrayBuffer }>) => {
  try { self.postMessage({ result: await importWorkbook(data.name, data.bytes) }); }
  catch (error) { self.postMessage({ error: (error as Error).message }); }
};
