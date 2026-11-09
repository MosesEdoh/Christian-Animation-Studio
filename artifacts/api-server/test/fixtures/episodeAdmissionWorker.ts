import {
  PostgresEpisodeAdmissionStore, acquireEpisodeExportLease, episodeExportAdmission,
} from "../../src/lib/episodeExportAdmission";
import { assembleEpisodeVideo, EpisodeVideoBusyError } from "../../src/lib/episodeVideo";

const store = new PostgresEpisodeAdmissionStore(process.argv[2], 2, 3000);
episodeExportAdmission.acquire = () => acquireEpisodeExportLease(store, {
  leaseMs: 3000, renewMs: 500, safetyMs: 1000,
});
const controllers = new Map<number, AbortController>();
globalThis.fetch = async (input, options) => {
  const id = Number(new URL(String(input)).pathname.slice(1));
  process.send!({ id, kind: "admitted" });
  return new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(options!.signal!.reason);
    options!.signal!.addEventListener("abort", abort, { once: true });
    if (options!.signal!.aborted) abort();
  });
};
process.on("message", async (message: { command: string; id: number }) => {
  if (message.command === "cancel") {
    controllers.get(message.id)?.abort();
    return;
  }
  const controller = new AbortController();
  controllers.set(message.id, controller);
  try {
    await assembleEpisodeVideo([{
      id: message.id, provider: "test", status: "ready", url: `https://media.example/${message.id}`,
    }], undefined, controller.signal);
    process.send!({ id: message.id, kind: "unexpected-success" });
  } catch (error) {
    process.send!({
      id: message.id,
      kind: error instanceof EpisodeVideoBusyError ? "busy" : controller.signal.aborted ? "cancelled" : "error",
    });
  } finally {
    controllers.delete(message.id);
  }
});
process.send!({ kind: "ready", id: 0 });
