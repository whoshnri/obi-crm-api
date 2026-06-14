import { reconcileScheduledEventsOnBoot } from "../lib/event-scheduler.js";

let started = false;

export function startJobs() {
  if (started) return;
  started = true;

  void reconcileScheduledEventsOnBoot();
}

startJobs();
