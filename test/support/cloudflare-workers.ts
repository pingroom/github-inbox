/**
 * Stand-in for the `cloudflare:workers` module, which exists only inside
 * workerd. vitest.config.ts points the import here so the inbox Worker's
 * entry module can be loaded under Node. Only what the entry uses is here.
 */

export class DurableObject<Env = unknown> {
  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: Env,
  ) {}
}
