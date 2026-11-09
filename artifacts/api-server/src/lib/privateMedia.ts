import type { File } from "@google-cloud/storage";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { objectStorageClient, ObjectStorageService } from "./objectStorage";

export async function storePrivateMedia(localPath: string, extension = "mp4", contentType = "video/mp4", signal?: AbortSignal) {
  const service = new ObjectStorageService();
  const directory = service.getPrivateObjectDir().replace(/^\/|\/$/g, "");
  const [bucket, ...prefix] = directory.split("/");
  const entity = `exports/${randomUUID()}.${extension}`;
  if (signal) {
    signal.throwIfAborted();
    const file = objectStorageClient.bucket(bucket!).file(`${prefix.join("/")}/${entity}`);
    try {
      await pipeline(createReadStream(localPath), file.createWriteStream({
        resumable: false, metadata: { contentType, cacheControl: "private, no-store" },
      }), { signal });
      signal.throwIfAborted();
    } catch (error) {
      await file.delete({ ignoreNotFound: true });
      throw error;
    }
    return `/objects/${entity}`;
  }
  await objectStorageClient.bucket(bucket!).upload(localPath, {
    destination: `${prefix.join("/")}/${entity}`,
    metadata: { contentType, cacheControl: "private, no-store" },
  });
  return `/objects/${entity}`;
}

// Native players and browsers issue byte-range requests when seeking MP4s.
export async function streamPrivateMedia(file: File, req: Request, res: Response) {
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", metadata.contentType || "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  let start = 0;
  let end = size - 1;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`); res.end(); return;
    }
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`); res.end(); return;
    }
    res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  res.setHeader("Content-Length", end - start + 1);
  if (req.method === "HEAD") { res.end(); return; }
  const stream = file.createReadStream({ start, end });
  stream.on("error", error => {
    // Seeking and switching previews intentionally cancel older range requests.
    if (res.destroyed || res.writableEnded) return;
    req.log.error({ err: error }, "Private file stream failed");
    res.destroy();
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
