import schedule from "node-schedule";

type ScheduledTask = () => Promise<void> | void;

function formatInMs(date: Date) {
  const inMs = Math.max(0, date.getTime() - Date.now());
  if (inMs < 60_000) return `${Math.round(inMs / 1000)}s`;
  if (inMs < 3_600_000) return `${Math.round(inMs / 60_000)}m`;
  return `${(inMs / 3_600_000).toFixed(1)}h`;
}

export function scheduleCronJob(name: string, rule: string, task: ScheduledTask) {
  schedule.cancelJob(name);
  return schedule.scheduleJob(name, rule, async () => {
    try {
      await task();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scheduler] error in ${name}: ${message}`);
    }
  });
}

export function scheduleOneOffJob(name: string, date: Date, task: ScheduledTask) {
  schedule.cancelJob(name);
  console.log(`[scheduler] registered ${name} at ${date.toISOString()} (in ${formatInMs(date)})`);
  return schedule.scheduleJob(name, date, async () => {
    console.log(`[scheduler] fired ${name}`);
    try {
      await task();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scheduler] error in ${name}: ${message}`);
    }
  });
}

export function cancelScheduledJob(name: string) {
  const cancelled = schedule.cancelJob(name);
  if (cancelled) {
    console.log(`[scheduler] cancelled ${name}`);
  }
}
