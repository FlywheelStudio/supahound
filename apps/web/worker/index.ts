import handler from "vinext/server/fetch-handler";
import { scheduledHeartbeat } from "../lib/heartbeat";

// The web Worker's entry (issue #159). Requests go to vinext's handler unchanged; the cron in
// wrangler.jsonc runs the staff heartbeat's "stale" check (lib/heartbeat.ts).
export * from "vinext/server/fetch-handler";

export default {
  fetch: handler.fetch,
  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(scheduledHeartbeat(controller.scheduledTime, env));
  },
} satisfies ExportedHandler<Env>;
