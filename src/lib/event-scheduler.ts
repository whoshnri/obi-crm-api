import { EventStatus } from "@prisma/client";
import { cancelScheduledJob, scheduleOneOffJob } from "../jobs/scheduler.js";
import { executeEmailEvent } from "../jobs/executeEmailEvent.js";
import { executeInvoiceEvent } from "../jobs/executeInvoiceEvent.js";
import { validateEventsForDeploy } from "./events/validate-deploy.js";
import { prisma } from "./prisma.js";
import { addNotificationForAdminsDeduped } from "./notifications.js";
import { logEventExecution } from "./observability/event-logger.js";
import { errorMessage } from "../jobs/utils.js";

async function markEventInfrastructureFailure(eventId: string, error: unknown) {
  const message = errorMessage(error);
  const updated = await prisma.event.updateMany({
    where: {
      id: eventId,
      status: { in: [EventStatus.pending, EventStatus.processing] },
    },
    data: {
      status: EventStatus.failed,
      executionMetadata: {
        lastPhase: "failed",
        reason: "infrastructure_error",
        error: message,
        failedAt: new Date().toISOString(),
      },
    },
  });

  if (updated.count > 0) {
    logEventExecution({
      eventId,
      phase: "fail",
      status: "failed",
      error: message,
      meta: { reason: "infrastructure_error" },
    });
  }
}

export const OVERDUE_GRACE_MS = 2 * 60 * 60 * 1000;

export type DeployScheduleResult = {
  scheduled: number;
  immediate: number;
  skipped: number;
  validationIssues: Array<{
    eventId: string;
    eventName: string;
    errors: string[];
    warnings: string[];
  }>;
  nextEventAt: string | null;
};

export function getEventCronJobId(eventId: string) {
  return `obi-event-${eventId}`;
}

export function resolveScheduleDate(scheduledAt: Date, now = new Date()) {
  const scheduledMs = scheduledAt.getTime();
  const nowMs = now.getTime();

  if (scheduledMs > nowMs) return scheduledAt;
  if (nowMs - scheduledMs <= OVERDUE_GRACE_MS) return now;
  return null;
}

async function routeEventExecution(eventId: string) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { baseType: true }
  });

  if (!event) return;

  if (event.baseType === "send_email") {
    await executeEmailEvent(eventId);
    return;
  }

  if (event.baseType === "send_invoice") {
    await executeInvoiceEvent(eventId);
  }
}

export async function executeScheduledEvent(eventId: string) {
  logEventExecution({
    eventId,
    phase: "trigger",
    status: "started",
    meta: { source: "scheduler" },
  });

  try {
    await routeEventExecution(eventId);
  } catch (error) {
    await markEventInfrastructureFailure(eventId, error);
  }
}

export async function failSkippedOverdueEvent(eventId: string, scheduledAt: Date) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, programmeId: true }
  });

  if (!event) return;

  await prisma.event.update({
    where: { id: eventId },
    data: {
      status: EventStatus.failed,
      executionMetadata: {
        lastPhase: "skipped",
        reason: "overdue_grace_expired",
        scheduledAt: scheduledAt.toISOString()
      }
    }
  });

  await addNotificationForAdminsDeduped(
    {
      type: "event_failed",
      title: "Overdue event skipped",
      message: `Event "${event.name}" was more than 2 hours overdue and was not executed.`,
      meta: {
        eventId,
        programmeId: event.programmeId,
        scheduledAt: scheduledAt.toISOString(),
        reason: "overdue_grace_expired"
      }
    },
    `event_overdue_skipped:${eventId}`
  );
}

export async function cancelEventCron(eventId: string) {
  cancelScheduledJob(getEventCronJobId(eventId));
}

export async function scheduleEventCron(event: { id: string; scheduledAt: Date }) {
  const cronJobId = getEventCronJobId(event.id);
  cancelScheduledJob(cronJobId);

  const runAt = resolveScheduleDate(event.scheduledAt);
  if (!runAt) {
    await failSkippedOverdueEvent(event.id, event.scheduledAt);
    return { scheduled: false as const, reason: "overdue_grace_expired" as const };
  }

  logEventExecution({
    eventId: event.id,
    phase: "schedule",
    status: "scheduled",
    meta: { runAt: runAt.toISOString() }
  });

  if (runAt.getTime() <= Date.now() + 1_000) {
    console.log(`[scheduler] running ${event.id} immediately`);
    void executeScheduledEvent(event.id);
    return { scheduled: true as const, runAt, immediate: true as const };
  }

  scheduleOneOffJob(cronJobId, runAt, async () => {
    await executeScheduledEvent(event.id);
  });

  return { scheduled: true as const, runAt, immediate: false as const };
}

export async function findDeployableEvents(filter: { programmeId?: string; cohortId?: string }) {
  return prisma.event.findMany({
    where: {
      ...(filter.programmeId
        ? { programmeId: filter.programmeId, eventFlow: { programmeId: filter.programmeId } }
        : {}),
      ...(filter.cohortId
        ? { cohortId: filter.cohortId, cohortEventFlow: { cohortId: filter.cohortId } }
        : {}),
      status: { in: [EventStatus.pending, EventStatus.failed] }
    },
    orderBy: { scheduledAt: "asc" }
  });
}

export async function resetFailedEventsForDeploy(events: Array<{ id: string; status: EventStatus }>) {
  const failedIds = events.filter((event) => event.status === EventStatus.failed).map((event) => event.id);
  if (failedIds.length === 0) return 0;

  await prisma.event.updateMany({
    where: { id: { in: failedIds } },
    data: {
      status: EventStatus.pending,
      attemptCount: 0,
      lastAttemptAt: null,
      executionMetadata: {}
    }
  });

  return failedIds.length;
}

export async function scheduleDeployedEvents(
  events: Array<{ id: string; scheduledAt: Date }>,
  options?: { validate?: boolean; checkAttachments?: boolean; skipInvalid?: boolean }
): Promise<DeployScheduleResult> {
  const fullEvents =
    options?.validate === false
      ? []
      : await prisma.event.findMany({
          where: { id: { in: events.map((event) => event.id) } }
        });

  const validation = options?.validate === false
    ? { ok: true, issues: [], blocking: [] }
    : await validateEventsForDeploy(fullEvents, { checkAttachments: options?.checkAttachments });

  if (!validation.ok && !options?.skipInvalid) {
    return {
      scheduled: 0,
      immediate: 0,
      skipped: 0,
      validationIssues: validation.blocking,
      nextEventAt: null
    };
  }

  const blockedIds = new Set(validation.blocking.map((issue) => issue.eventId));
  const schedulable = events.filter((event) => !blockedIds.has(event.id));
  const results = await Promise.all(schedulable.map((event) => scheduleEventCron(event)));
  const skipped = results.filter((result) => !result.scheduled).length;
  const immediate = results.filter((result) => result.scheduled && "immediate" in result && result.immediate).length;
  const futureRuns = results
    .flatMap((result) =>
      result.scheduled && "runAt" in result && result.runAt.getTime() > Date.now() ? [result.runAt] : [],
    )
    .sort((a, b) => a.getTime() - b.getTime());

  if (skipped > 0) {
    await addNotificationForAdminsDeduped(
      {
        type: "event_failed",
        title: "Some events were not scheduled",
        message: `${skipped} event(s) were more than 2 hours overdue and were marked failed.`,
        meta: { skipped, reason: "overdue_grace_expired" }
      },
      `deploy_overdue_skipped:${schedulable.map((event) => event.id).join(",")}`
    );
  }

  return {
    scheduled: results.filter((result) => result.scheduled).length,
    immediate,
    skipped,
    validationIssues: validation.issues,
    nextEventAt: futureRuns[0]?.toISOString() ?? null
  };
}

export async function runEventNow(eventId: string) {
  await cancelEventCron(eventId);
  await prisma.event.update({
    where: { id: eventId },
    data: {
      status: EventStatus.pending,
      attemptCount: 0,
      lastAttemptAt: null,
      executionMetadata: {},
    },
  });
  await executeScheduledEvent(eventId);
}

export async function reconcileScheduledEventsOnBoot() {
  const events = await prisma.event.findMany({
    where: {
      status: EventStatus.pending,
      OR: [
        { eventFlow: { deployedAt: { not: null } } },
        { cohortEventFlow: { deployedAt: { not: null } } }
      ]
    },
    select: { id: true, scheduledAt: true }
  });

  if (events.length === 0) return { reconciled: 0, skipped: 0 };

  const result = await scheduleDeployedEvents(events, { validate: false });
  logEventExecution({
    eventId: "boot-reconcile",
    phase: "schedule",
    status: "reconciled",
    meta: {
      total: events.length,
      scheduled: result.scheduled,
      skipped: result.skipped,
      immediate: result.immediate
    }
  });

  return { reconciled: result.scheduled, skipped: result.skipped };
}

export async function scheduleOnFlowSave(filter: { programmeId?: string; cohortId?: string }) {
  const events = await findDeployableEvents(filter);
  await resetFailedEventsForDeploy(events);

  const scheduleResult = await scheduleDeployedEvents(
    events.map((event: any) => ({ id: event.id, scheduledAt: event.scheduledAt })),
    { checkAttachments: false, skipInvalid: true },
  );

  logEventExecution({
    eventId: filter.programmeId ? `programme:${filter.programmeId}` : `cohort:${filter.cohortId}`,
    phase: "schedule",
    status: "flow_saved",
    meta: {
      eventCount: events.length,
      scheduled: scheduleResult.scheduled,
      immediate: scheduleResult.immediate,
      skipped: scheduleResult.skipped,
      nextEventAt: scheduleResult.nextEventAt,
      blocked: scheduleResult.validationIssues?.filter((issue) => issue.errors.length > 0).length ?? 0,
    },
  });

  return {
    ok: true,
    ...scheduleResult,
  };
}
