/**
 * PingRoom GitHub inbox Worker.
 *
 * A Cron Trigger fires every minute and asks one Durable Object to poll. The
 * Durable Object holds the poller's state, so the state has one writer and
 * two runs cannot both send a thread. The Worker has no HTTP surface: no
 * route, no workers.dev address and no fetch handler.
 *
 * A Worker's entry module may export only its handler and its Durable Object
 * classes: workerd refuses to start one that exports anything else, a
 * constant included. Everything else lives in other modules.
 */

import { DurableObject } from "cloudflare:workers";
import type { InboxEnv } from "./config";
import { InboxPoller } from "./poller";

export interface WorkerEnv extends InboxEnv {
  INBOX: DurableObjectNamespace<GitHubInbox>;
}

export class GitHubInbox extends DurableObject<WorkerEnv> {
  private readonly poller: InboxPoller;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.poller = new InboxPoller({
      storage: ctx.storage,
      env,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (line) => console.log(line),
    });
  }

  async poll(): Promise<void> {
    await this.poller.run();
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: WorkerEnv, _ctx: ExecutionContext): Promise<void> {
    await env.INBOX.getByName("inbox").poll();
  },
} satisfies ExportedHandler<WorkerEnv>;
