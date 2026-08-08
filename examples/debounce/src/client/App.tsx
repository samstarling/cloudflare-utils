import type { DebounceAndLeaseStatus } from "@samstarling/cloudflare-utils-debounce";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ExampleRun } from "../shared";

const POLL_INTERVAL_MS = 300;

type LogEntry = { id: string; at: number; message: string; color?: string };

async function callApi(key: string, action: "signal" | "flush"): Promise<void> {
  await fetch(`/api/${encodeURIComponent(key)}/${action}`, { method: "POST" });
}

async function fetchStatus(key: string): Promise<DebounceAndLeaseStatus> {
  const res = await fetch(`/api/${encodeURIComponent(key)}/status`);
  return res.json();
}

async function fetchRuns(key: string): Promise<ExampleRun[]> {
  const res = await fetch(`/api/${encodeURIComponent(key)}/runs`);
  return res.json();
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Run starts/finishes come from the Durable Object's own durable history, so they survive a
 * reload; state transitions are only observed by this tab's polling. Merging them newest-first
 * gives one chronological activity feed.
 */
function toLogEntries(runs: ExampleRun[]): LogEntry[] {
  return runs.flatMap((run) => {
    const entries: LogEntry[] = [
      {
        id: `run-${run.epoch}-start`,
        at: run.startedAt,
        message: `run() started (epoch ${run.epoch})`,
        color: "#059669",
      },
    ];
    if (run.endedAt !== undefined) {
      const took = formatDuration(run.endedAt - run.startedAt);
      entries.push(
        run.outcome === "superseded"
          ? {
              id: `run-${run.epoch}-end`,
              at: run.endedAt,
              message: `run() superseded by a reclaim after ${took} — side effect skipped`,
              color: "#dc2626",
            }
          : {
              id: `run-${run.epoch}-end`,
              at: run.endedAt,
              message: `run() finished in ${took}`,
              color: "#047857",
            },
      );
    }
    return entries;
  });
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions);
}

function StateBadge({ state }: { state: DebounceAndLeaseStatus["state"] }) {
  const colors: Record<DebounceAndLeaseStatus["state"], string> = {
    idle: "#6b7280",
    pending: "#d97706",
    claimed: "#059669",
    exhausted: "#dc2626", // terminal and needs operator attention, so it reads as an error
  };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.25rem 0.75rem",
        borderRadius: "999px",
        background: colors[state],
        color: "white",
        fontWeight: 600,
        fontSize: "0.85rem",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {state === "claimed" && <span className="pulse-dot" />}
      {state}
    </span>
  );
}

export function App() {
  const [key, setKey] = useState("acme");
  const [status, setStatus] = useState<DebounceAndLeaseStatus | null>(null);
  const [transitions, setTransitions] = useState<LogEntry[]>([]);
  const [runs, setRuns] = useState<ExampleRun[]>([]);
  const lastSince = useRef<number | null>(null);
  const currentKey = useRef(key);

  const refresh = useCallback(async (k: string) => {
    const [next, nextRuns] = await Promise.all([fetchStatus(k), fetchRuns(k)]);
    if (k !== currentKey.current) return; // stale response for a key the user has since changed
    setStatus(next);
    setRuns(nextRuns);
    if (lastSince.current !== null && lastSince.current !== next.since) {
      const at = Date.now();
      setTransitions((prev) =>
        [{ id: `state-${at}`, at, message: `-> ${next.state}` }, ...prev].slice(0, 20),
      );
    }
    lastSince.current = next.since ?? null;
  }, []);

  useEffect(() => {
    currentKey.current = key;
    lastSince.current = null;
    setStatus(null);
    setTransitions([]);
    setRuns([]);
    refresh(key);
    const id = setInterval(() => refresh(key), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [key, refresh]);

  const log = [...transitions, ...toLogEntries(runs)].sort((a, b) => b.at - a.at).slice(0, 20);

  const now = Date.now();
  const remainingMs =
    status?.state === "pending" && status.debounceDeadline !== undefined
      ? Math.max(0, status.debounceDeadline - now)
      : undefined;
  const elapsedMs = status?.state === "claimed" ? Math.max(0, now - status.since) : undefined;

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 640,
        margin: "3rem auto",
        padding: "0 1.5rem",
        color: "#111827",
      }}
    >
      <h1 style={{ fontSize: "1.5rem" }}>cloudflare-utils-debounce</h1>
      <p style={{ color: "#6b7280" }}>
        Live demo — send signals, watch them debounce, then collapse into one exclusive run.
      </p>

      <label
        htmlFor="key-input"
        style={{ display: "block", fontSize: "0.85rem", color: "#6b7280", marginTop: "1.5rem" }}
      >
        Key
      </label>
      <input
        id="key-input"
        value={key}
        onChange={(e) => setKey(e.target.value || "acme")}
        style={{
          fontSize: "1rem",
          padding: "0.5rem",
          width: "100%",
          boxSizing: "border-box",
          border: "1px solid #d1d5db",
          borderRadius: "0.375rem",
        }}
      />

      <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
        <button type="button" onClick={() => callApi(key, "signal")} style={buttonStyle}>
          Send signal
        </button>
        <button
          type="button"
          onClick={() => callApi(key, "flush")}
          style={{ ...buttonStyle, background: "#111827" }}
        >
          Flush now
        </button>
      </div>

      <div
        style={{
          marginTop: "2rem",
          padding: "1.25rem",
          border: "1px solid #e5e7eb",
          borderRadius: "0.5rem",
        }}
      >
        {status ? (
          <>
            <StateBadge state={status.state} />
            <div style={{ marginTop: "0.75rem", fontSize: "0.9rem", color: "#374151" }}>
              <div>since {status.since !== undefined ? formatTime(status.since) : "never"}</div>
              {remainingMs !== undefined && <div>runs in {(remainingMs / 1000).toFixed(1)}s</div>}
              {elapsedMs !== undefined && (
                <div style={{ color: "#059669", fontWeight: 600 }}>
                  running for {(elapsedMs / 1000).toFixed(1)}s
                </div>
              )}
              {status.coalescedPending && (
                <div style={{ color: "#d97706" }}>
                  a queued signal/flush is waiting for this run to finish
                </div>
              )}
            </div>
          </>
        ) : (
          <span style={{ color: "#6b7280" }}>loading…</span>
        )}
      </div>

      <h2 style={{ fontSize: "1rem", marginTop: "2rem" }}>Activity</h2>
      <ul style={{ listStyle: "none", padding: 0, fontSize: "0.85rem", color: "#374151" }}>
        {log.length === 0 && <li style={{ color: "#9ca3af" }}>no activity yet</li>}
        {log.map((entry) => (
          <li key={entry.id} style={entry.color ? { color: entry.color } : undefined}>
            <span style={{ color: "#9ca3af" }}>{formatTime(entry.at)}</span> {entry.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  fontSize: "0.95rem",
  padding: "0.5rem 1rem",
  borderRadius: "0.375rem",
  border: "none",
  background: "#2563eb",
  color: "white",
  cursor: "pointer",
};
