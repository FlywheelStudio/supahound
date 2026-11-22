import { objectKey, toRecord, worthKeeping } from "./record";

// The tail consumer of the web and poller Workers (decision 047). Each call gets the trace items
// of one producer invocation; the ones worth keeping go to R2 as one NDJSON object. The bucket's
// lifecycle rule deletes objects after 90 days. Nothing is logged here: a failed write throws,
// and Workers Logs shows that this Worker failed.

export interface SinkEnv {
  LOGS: Pick<R2Bucket, "put">;
}

export async function writeTail(events: readonly TraceItem[], env: SinkEnv, random: () => string = () => crypto.randomUUID()): Promise<string | null> {
  const records = events.map(toRecord).filter(worthKeeping);
  if (records.length === 0) return null;
  const key = objectKey(records[0]!.ts, random());
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await env.LOGS.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } });
  return key;
}

export default {
  async tail(events, env): Promise<void> {
    await writeTail(events, env);
  },
} satisfies ExportedHandler<Env>;
