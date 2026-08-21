import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

function success(value) { return Object.freeze({ ok: true, value: Object.freeze(value) }); }
function failure(code) { return Object.freeze({ ok: false, error: Object.freeze({ code }) }); }

const REMOTE_INITIALIZERS = [];
const decorate = (ctor, name, decorator) => {
  const descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, name);
  decorator(descriptor.value, { kind: "method", name, static: false, private: false, access: { has: (value) => name in value, get: (value) => value[name] }, addInitializer(initializer) { REMOTE_INITIALIZERS.push(initializer); } });
};

export class CodexAppServerService extends TypertRemoteService {
  constructor(ctx, { adapter } = {}) {
    super(ctx, "codexAppserver");
    for (const initialize of REMOTE_INITIALIZERS) initialize.call(this);
    this.adapter = adapter;
    this.snapshot = null;
    this.unsubscribe = adapter?.onRateLimits?.((snapshot) => { this.snapshot = snapshot; });
    ctx.effect(() => () => this.unsubscribe?.(), "dsh-codex-appserver: rate-limit cleanup");
  }

  async status() {
    if (!this.adapter) return failure("startup-failed");
    const status = await this.adapter.status();
    return status.available ? success(status) : failure(status.code);
  }

  async rateLimits(request) {
    if (!this.adapter) return failure("rate-limits-unavailable");
    try {
      const snapshot = await this.adapter.getRateLimits({ force: request?.force === true });
      this.snapshot = snapshot;
      return success(snapshot);
    } catch (error) {
      return failure(error?.code ?? "rate-limits-unavailable");
    }
  }
}
decorate(CodexAppServerService, "status", Remote("status"));
decorate(CodexAppServerService, "rateLimits", Remote("rateLimits"));
