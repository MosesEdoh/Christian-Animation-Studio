// Always compress off-thread, including archives made up of many small files.
// Do not fall back to main-thread compression if workers are unavailable.
export function compressArchive(
  files: Record<string, Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./zipArchive.worker.ts', import.meta.url), { type: 'module' });
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    const onAbort = () => {
      cleanup();
      reject(signal!.reason);
    };
    worker.onmessage = (event: MessageEvent<Uint8Array<ArrayBuffer>>) => {
      cleanup();
      if (signal?.aborted) reject(signal.reason);
      else resolve(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      cleanup();
      reject(new Error(event.message || 'The series ZIP could not be packed. Please retry.'));
    };
    worker.onmessageerror = () => {
      cleanup();
      reject(new Error('The packed series ZIP could not be read. Please retry.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // The archive builder no longer needs these bytes. Transfer ownership
      // instead of copying potentially hundreds of megabytes on the UI thread.
      const buffers = new Set<ArrayBuffer>();
      for (const bytes of Object.values(files)) {
        if (bytes.buffer instanceof ArrayBuffer) buffers.add(bytes.buffer);
      }
      worker.postMessage(files, [...buffers]);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
