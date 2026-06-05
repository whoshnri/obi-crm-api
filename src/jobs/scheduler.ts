import schedule from "node-schedule";

type ScheduledTask = () => Promise<void> | void;

export function scheduleCronJob(name: string, rule: string, task: ScheduledTask) {
  schedule.cancelJob(name);
  return schedule.scheduleJob(name, rule, async () => {
    try {
      await task();
    } catch (error) {
      console.error("[scheduler:error]", JSON.stringify({ name, message: error instanceof Error ? error.message : String(error) }));
    }
  });
}

export function scheduleOneOffJob(name: string, date: Date, task: ScheduledTask) {
  schedule.cancelJob(name);
  return schedule.scheduleJob(name, date, async () => {
    try {
      await task();
    } catch (error) {
      console.error("[scheduler:error]", JSON.stringify({ name, message: error instanceof Error ? error.message : String(error) }));
    }
  });
}

export function cancelScheduledJob(name: string) {
  schedule.cancelJob(name);
}
