import { Worker as Thread } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Both test commands run in a sibling artifact (api-server or creative-studio).
const require = createRequire(resolve(process.cwd(), '../api-server/package.json'));
const tsxApi = require.resolve('tsx/esm/api');

// Run the actual browser worker entry in a real background thread. Only the
// browser messaging API is adapted; compression and transfer lists are real.
export class NodeZipWorker {
  static instances: NodeZipWorker[] = [];
  readonly thread: Thread;
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  started: Promise<void>;

  constructor(url: URL) {
    NodeZipWorker.instances.push(this);
    const workerUrl = url.protocol === 'file:' ? url.href
      : pathToFileURL(url.pathname.startsWith('/@fs/')
        ? url.pathname.slice('/@fs'.length)
        : resolve(process.cwd(), `.${url.pathname}`)).href;
    this.thread = new Thread(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { register } = await import(workerData.tsxApi);
        register();
        globalThis.postMessage = (data, transfer) => parentPort.postMessage({ data }, transfer);
        await import(workerData.url);
        parentPort.on('message', data => {
          parentPort.postMessage({ started: true });
          globalThis.onmessage({ data });
        });
      })().catch(error => { setImmediate(() => { throw error; }); });
    `, { eval: true, workerData: { url: workerUrl, tsxApi } });
    this.started = new Promise(resolve => {
      this.thread.on('message', message => {
        if (message.started) resolve();
        else this.onmessage?.({ data: message.data });
      });
    });
    this.thread.on('error', error => this.onerror?.({ message: error.message, preventDefault() {} }));
    this.thread.on('messageerror', () => this.onmessageerror?.());
  }

  postMessage(data: unknown, transfer: ArrayBuffer[]) {
    this.thread.postMessage(data, transfer);
  }

  terminate() {
    this.terminated = true;
    void this.thread.terminate();
  }
}
