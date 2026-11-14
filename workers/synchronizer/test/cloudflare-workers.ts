/** A stand-in for `cloudflare:workers` in Node tests: only what the synchronizer extends. */
export class DurableObject<Env = unknown> {
  ctx: unknown
  env: Env
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}
