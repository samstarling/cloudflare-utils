// Types shared between the Worker and the React client. Kept free of Workers-only types (Env,
// DurableObjectState) so the browser build can import it without pulling in worker-configuration.

/** One `run()` invocation, as recorded by ExampleDebounceAndLease for the dashboard. */
export type ExampleRun = {
  epoch: number;
  startedAt: number;
  /** Absent while the run is still in flight. */
  endedAt?: number;
  /** `superseded` means a lease-expiry reclaim took over before this run reached its side effect. */
  outcome?: "completed" | "superseded";
};
