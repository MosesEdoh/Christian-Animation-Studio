import { zipSync } from 'fflate';

// A narrow worker scope avoids adding conflicting DOM/WebWorker global types
// to the application's TypeScript configuration.
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<Record<string, Uint8Array>>) => void;
  postMessage: (archive: Uint8Array<ArrayBuffer>, transfer: ArrayBuffer[]) => void;
};

scope.onmessage = ({ data }) => {
  const archive = zipSync(data, { level: 6 });
  scope.postMessage(archive, [archive.buffer]);
};
