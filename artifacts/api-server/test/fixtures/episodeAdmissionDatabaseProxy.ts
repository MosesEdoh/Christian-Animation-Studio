import { createConnection, createServer, type Server, type Socket } from "node:net";

export interface EpisodeAdmissionDatabaseProxy {
  readonly connectionString: string;
  setAvailable(available: boolean): void;
  close(): Promise<void>;
}

export async function createEpisodeAdmissionDatabaseProxy(
  connectionString: string,
): Promise<EpisodeAdmissionDatabaseProxy> {
  const databaseUrl = new URL(connectionString);
  const targetHost = databaseUrl.hostname;
  const targetPort = Number(databaseUrl.port || 5432);
  const sockets = new Set<Socket>();
  let available = true;
  const server: Server = createServer(client => {
    if (!available) {
      client.destroy();
      return;
    }
    const upstream = createConnection({ host: targetHost, port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    client.on("error", () => {});
    upstream.on("error", () => {});
    client.on("close", () => sockets.delete(client));
    upstream.on("close", () => sockets.delete(upstream));
    upstream.once("connect", () => {
      if (!available) {
        client.destroy();
        upstream.destroy();
        return;
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  });
  server.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw new Error("Could not start the episode admission database proxy.");
  }

  databaseUrl.hostname = "127.0.0.1";
  databaseUrl.port = String(address.port);

  return {
    connectionString: databaseUrl.toString(),
    setAvailable(nextAvailable) {
      available = nextAvailable;
      if (!available) {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
