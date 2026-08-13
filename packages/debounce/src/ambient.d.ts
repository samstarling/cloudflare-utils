// Build-only substitute for the ambient Cloudflare Workers types this library relies on but
// deliberately does not depend on (see README: consumers supply these via their own
// `wrangler types` run). `test/worker-configuration.d.ts` (the real, generated version used for
// dev/test typechecking, see tsconfig.json) can't be reused for `tsc -p tsconfig.build.json`
// because it inline-references the test fixture's own entry file, which sits outside `src/` and
// would violate this build's `rootDir`. This file is excluded from the main tsconfig.json
// (see its "exclude") to avoid colliding with the real declarations during normal typecheck/test.

interface AlarmInvocationInfo {
  readonly isRetry: boolean;
  readonly retryCount: number;
  readonly scheduledTime: number;
}

// Only the slice of the platform's AbortSignal this library touches: it constructs one via
// `AbortSignal.timeout()` and hands it to run(). `aborted` is included so a subclass compiled
// against these build-only types can still read it. The real, fuller definition is supplied by
// the consumer's runtime types at their build time (and by the test types during typecheck).
interface AbortSignal {
  readonly aborted: boolean;
}
declare const AbortSignal: {
  prototype: AbortSignal;
  timeout(milliseconds: number): AbortSignal;
};

interface SyncKvStorage {
  get<T = unknown>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
}

interface DurableObjectStorage {
  kv: SyncKvStorage;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectId {
  readonly name?: string;
}

interface DurableObjectState<Props = unknown> {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  readonly props: Props;
  waitUntil(promise: Promise<unknown>): void;
}

declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown, Props = unknown> {
    protected ctx: DurableObjectState<Props>;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    alarm?(alarmInfo?: AlarmInvocationInfo): void | Promise<void>;
    fetch?(request: Request): Response | Promise<Response>;
  }
}
