import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// No real database, storage bucket, authentication, or rendering work is used.
// Keep the entry point, renderer, shared lease, and filesystem recovery real.
const stubs: Record<string, string> = {
  "./app": `
    import { createServer } from "node:http";
    export default {
      listen(_port, callback) {
        return createServer().listen(0, "127.0.0.1", () => {
          process.send({ kind: "listening" });
          callback();
        });
      }
    };`,
  "./lib/episodeVideo": `export function startEpisodeTemporaryRecovery() {}`,
  "./logger": `
    export const logger = {
      info() {},
      error(...args) { process.send({ kind: "log-error", error: String(args.at(-1)) }); },
      warn(...args) { process.send({ kind: "log-error", error: String(args.at(-1)) }); }
    };`,
  "@workspace/db": `
    export const studioExportsTable = {};
    export const studioProjectsTable = {};
    export const studioEpisodesTable = {};
    export const studioScenesTable = {};
    export const studioShotsTable = {};
    export const studioAssetsTable = {};
    export const db = {};
    export function createBoundedDatabase() {
      const query = {
        set() { return query; }, where() { return query; },
        from() { return query; }, orderBy() { return query; },
        limit() { return Promise.resolve([]); },
        then(resolve) { return Promise.resolve([]).then(resolve); }
      };
      return { update() { return query; }, select() { return query; } };
    }`,
  "./objectStorage": `export class ObjectStorageService { constructor() { throw new Error("Unexpected object storage access"); } }`,
  "./privateMedia": `export function storePrivateMedia() { throw new Error("Unexpected upload"); }`,
  "sharp": `export default function sharp() { throw new Error("Unexpected image rendering"); }`,
};

export async function bundleMovieRecoveryWorker() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../fixtures/movieRecoveryWorker.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", packages: "external",
    write: false,
    plugins: [{
      name: "isolate-unrelated-services",
      setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          // Both index.ts and movieRenderer.ts must share the same logger.
          const key = args.path === "./lib/logger" ? "./logger" : args.path;
          if (key in stubs) return { path: key, namespace: "recovery-test" };
        });
        build.onLoad({ filter: /.*/, namespace: "recovery-test" }, args => ({
          contents: stubs[args.path], loader: "js",
        }));
      },
    }],
  });
  return result.outputFiles[0].text;
}

type Message = {
  kind: string;
  directory?: string;
  pid?: number;
  removed?: number;
  now?: number;
  timers?: { ms: number; unrefs: number }[];
  created?: number;
  error?: string;
};

export function movieRecoveryProcess(source: string, root: string, mode: "owner" | "recovery", startupNow?: number) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    // Never pass workspace secrets into these isolated workers.
    env: {
      TMPDIR: root, PORT: "12345", RECOVERY_TEST_MODE: mode,
      ...(startupNow === undefined ? {} : { RECOVERY_TEST_NOW: String(startupNow) }),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", data => { stderr += data; });
  const messages: Message[] = [];
  child.on("message", message => { messages.push(message as Message); });
  // Attach immediately, before a signal or an early worker failure.
  const closed = once(child, "close");
  const wait = async (kind: string): Promise<Message> => {
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      const error = messages.find(message => /error$/.test(message.kind));
      assert.equal(error, undefined, JSON.stringify(error));
      const index = messages.findIndex(message => message.kind === kind);
      if (index !== -1) return messages.splice(index, 1)[0];
      assert.equal(child.exitCode, null, `Worker exited waiting for ${kind}: ${stderr}`);
      assert.equal(child.signalCode, null, `Worker killed waiting for ${kind}: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`Timed out waiting for ${kind}: ${stderr}; messages=${JSON.stringify(messages)}`);
  };
  return {
    child, closed, wait,
    send(command: string, now?: number) { child.send({ command, ...(now === undefined ? {} : { now }) }); },
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    },
  };
}
