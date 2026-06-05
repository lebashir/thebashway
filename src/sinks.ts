// src/sinks.ts
// Optional output sinks. A bare repo needs NONE of these — the defaults are no-ops,
// so the engine never depends on Telegram, Supabase, or any status file unless a
// project opts in via its binding. Opt-in adapters live in src/sinks/*.

/** Send a human-facing notification (e.g. Telegram). Default: no-op. */
export interface Notify {
  (msg: string): Promise<void>;
}

/** A structured agent event for an external feed (e.g. a Supabase table). */
export interface AgentEvent {
  action: "parked" | "unparked";
  target: string;
  reason?: string;
  cascade?: string[];
}

/** Emit an agent event to an external feed. Default: no-op. */
export interface EventSink {
  (e: AgentEvent): Promise<void>;
}

/** Refresh a "what's parked right now" section in a status file (e.g. NOW.md). Default: no-op. */
export interface StatusFile {
  refreshParked(items: { title: string; reason: string }[]): Promise<void>;
}

export interface SinkSet {
  notify: Notify;
  eventSink: EventSink;
  statusFile: StatusFile;
}

/** The zero-infrastructure default: everything resolves, nothing is sent. */
export function noopSinks(): SinkSet {
  return {
    notify: async (_msg: string) => {},
    eventSink: async (_e: AgentEvent) => {},
    statusFile: { refreshParked: async (_items) => {} },
  };
}
