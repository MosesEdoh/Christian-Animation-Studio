import {
  PostgresEpisodeAdmissionStore, acquireEpisodeExportLease, episodeExportAdmission,
  type EpisodeAdmissionStore,
} from "../../src/lib/episodeExportAdmission";
import { assembleEpisodeVideo, EpisodeVideoBusyError } from "../../src/lib/episodeVideo";

const [, , poolName, capacityArg, leaseMsArg, renewMsArg, safetyMsArg] = process.argv;
const capacity = Number(capacityArg ?? 2);
const leaseMs = Number(leaseMsArg ?? 3000);
const renewMs = Number(renewMsArg ?? 500);
const safetyMs = Number(safetyMsArg ?? 1000);
const store = new PostgresEpisodeAdmissionStore(poolName, capacity, leaseMs);
let lastOwner: string | undefined;
const ownersByRequest = new Map<number, string>();
const observedStore: EpisodeAdmissionStore = {
  async acquire(owner) {
    const acquired = await store.acquire(owner);
    if (acquired) lastOwner = owner;
    return acquired;
  },
  renew: owner => store.renew(owner),
  release: owner => store.release(owner),
};
episodeExportAdmission.acquire = () => acquireEpisodeExportLease(observedStore, {
  leaseMs, renewMs, safetyMs,
});
const controllers = new Map<number, AbortController>();
globalThis.fetch = async (input, options) => {
  const id = Number(new URL(String(input)).pathname.slice(1));
  if (lastOwner) ownersByRequest.set(id, lastOwner);
  process.send!({ id, kind: "admitted", owner: lastOwner });
  return new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(options!.signal!.reason);
    options!.signal!.addEventListener("abort", abort, { once: true });
    if (options!.signal!.aborted) abort();
  });
};
process.on("message", async (message: { command: string; id: number; targetId?: number }) => {
  if (message.command === "cancel") {
    controllers.get(message.id)?.abort();
    return;
  }
  if (message.command === "renew-old") {
    const owner = ownersByRequest.get(message.targetId ?? 1);
    process.send!({ id: message.id, kind: "stale-renewed", owned: owner ? await store.renew(owner) : null });
    return;
  }
  if (message.command === "release-old") {
    const owner = ownersByRequest.get(message.targetId ?? 1);
    if (owner) await store.release(owner);
    process.send!({ id: message.id, kind: "stale-released" });
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
      kind: error instanceof EpisodeVideoBusyError
        ? "busy"
        : controller.signal.aborted || (error instanceof Error && /ownership was lost/.test(error.message))
          ? "cancelled"
          : "error",
    });
  } finally {
    controllers.delete(message.id);
  }
});
process.send!({ kind: "ready", id: 0 });
