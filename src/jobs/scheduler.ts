type ScheduledTask = () => Promise<void> | void;

function getMinuteKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
}

export function startMinuteScheduler(
  shouldRun: (date: Date) => boolean,
  task: ScheduledTask
) {
  let lastMinuteKey = "";
  let running = false;

  const tick = () => {
    const now = new Date();
    const minuteKey = getMinuteKey(now);
    if (minuteKey === lastMinuteKey) {
      return;
    }

    lastMinuteKey = minuteKey;
    if (!shouldRun(now) || running) {
      return;
    }

    running = true;
    Promise.resolve(task())
      .catch((error) => {
        console.error("[scheduler:error]", JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
      })
      .finally(() => {
        running = false;
      });
  };

  tick();

  const interval = setInterval(tick, 1_000);
  interval.unref?.();
  return () => clearInterval(interval);
}
