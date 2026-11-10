export type EpisodeExportSignalFields = Record<string, unknown> & {
  event?: unknown;
};

type DeliveryFailure = "missing_configuration" | "invalid_destination" | "network_error" | `http_${number}`;

interface EpisodeExportAlertSinkOptions {
  sourceToken?: string;
  ingestingUrl?: string;
  enabled?: boolean;
  post?: (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status">>;
  onDeliveryFailure?: (reason: DeliveryFailure) => void;
}

const FORWARDED_EVENTS = new Set([
  "episode_export.coordination_failure",
  "episode_export.capacity_rejected",
]);

function isAllowedIngestHost(hostname: string): boolean {
  return hostname === "in.logs.betterstack.com" || hostname.endsWith(".betterstackdata.com");
}

export function createEpisodeExportAlertSink(options: EpisodeExportAlertSinkOptions) {
  const post = options.post ?? ((url, init) => fetch(url, init));

  return async (fields: EpisodeExportSignalFields, message: string): Promise<void> => {
    if (!options.enabled || !FORWARDED_EVENTS.has(String(fields.event))) return;

    const sourceToken = options.sourceToken?.trim();
    const ingestingUrl = options.ingestingUrl?.trim();
    if (!sourceToken || !ingestingUrl) {
      options.onDeliveryFailure?.("missing_configuration");
      return;
    }

    let destination: URL;
    try {
      const normalizedIngestingUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(ingestingUrl)
        ? ingestingUrl
        : `https://${ingestingUrl}`;
      destination = new URL(normalizedIngestingUrl);
      if (
        destination.protocol !== "https:"
        || destination.username
        || destination.password
        || destination.search
        || destination.hash
        || !isAllowedIngestHost(destination.hostname)
      ) {
        options.onDeliveryFailure?.("invalid_destination");
        return;
      }
    } catch {
      options.onDeliveryFailure?.("invalid_destination");
      return;
    }

    try {
      const response = await post(destination.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${sourceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...fields,
          service: "frame-faith-api-server",
          message,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) options.onDeliveryFailure?.(`http_${response.status}`);
    } catch {
      options.onDeliveryFailure?.("network_error");
    }
  };
}
