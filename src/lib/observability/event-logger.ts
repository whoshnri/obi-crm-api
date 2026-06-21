export type EventExecutionLogPayload = {
  eventId: string;
  programmeId?: string;
  cohortId?: string | null;
  baseType?: string;
  phase: "claim" | "validate" | "send" | "complete" | "fail" | "retry" | "schedule" | "deploy" | "trigger" | "cancel";
  status?: string;
  recipientCount?: number;
  durationMs?: number;
  attemptCount?: number;
  error?: string;
  meta?: Record<string, unknown>;
};

function shortError(error?: string) {
  if (!error) return "";
  const firstLine = error.split("\n").map((line) => line.trim()).find(Boolean) ?? error;
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}

function formatEventLog(payload: EventExecutionLogPayload) {
  const eventRef = payload.eventId;
  const type = payload.baseType ? ` (${payload.baseType})` : "";

  switch (payload.phase) {
    case "trigger":
      return `[event] ${eventRef}${type} — started`;
    case "claim":
      if (payload.status === "skipped") {
        return `[event] ${eventRef}${type} — skipped (not pending)`;
      }
      return `[event] ${eventRef}${type} — claimed (attempt ${payload.attemptCount ?? 1})`;
    case "cancel":
      return `[event] ${eventRef}${type} — cancellation ${payload.status ?? ""}`;
    case "schedule":
      if (payload.status === "flow_saved") {
        const meta = payload.meta ?? {};
        return `[event] flow saved — scheduled ${meta.scheduled ?? 0}, immediate ${meta.immediate ?? 0}, skipped ${meta.skipped ?? 0}`;
      }
      if (payload.status === "reconciled") {
        const meta = payload.meta ?? {};
        return `[event] boot reconcile — scheduled ${meta.scheduled ?? 0} of ${meta.total ?? 0}`;
      }
      return `[event] ${eventRef} — scheduled for ${payload.meta?.runAt ?? "soon"}`;
    case "complete":
      return `[event] ${eventRef}${type} — completed (${payload.recipientCount ?? 0} recipients, ${payload.durationMs ?? 0}ms)`;
    case "fail":
      return `[event] ${eventRef}${type} — failed: ${shortError(payload.error)}`;
    case "retry":
      return `[event] ${eventRef} — retry ${payload.attemptCount ?? "?"}: ${shortError(payload.error)}`;
    default:
      return `[event] ${eventRef}${type} — ${payload.phase} ${payload.status ?? ""}`.trim();
  }
}

export function logEventExecution(payload: EventExecutionLogPayload) {
  console.log(formatEventLog(payload));
}
