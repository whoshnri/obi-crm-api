import { EventStatus, OpportunityEventStatus } from "@prisma/client";
import {
  cancelScheduledJob,
  scheduleCronJob,
  LogStatus,
  getActiveScheduledJobs,
} from "../jobs/scheduler.js";
import { scheduleOpportunityCron } from "./opportunity-scheduler.js";
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
    select: { baseType: true },
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
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { status: true },
    });
    if (event?.status === EventStatus.completed) {
      await cancelEventCron(eventId, "completed");
    } else if (event?.status === EventStatus.failed) {
      await cancelEventCron(eventId, "failed");
    } else {
      await cancelEventCron(eventId, "completed");
    }
  } catch (error) {
    await markEventInfrastructureFailure(eventId, error);
    await cancelEventCron(eventId, "failed");
  }
}

export async function cancelEventCron(eventId: string, status?: LogStatus) {
  const res = await cancelScheduledJob(eventId, status);
  if (res) {
    logEventExecution({
      eventId,
      phase: "cancel",
      status: "success",
    });
  } else {
    console.error(
      `[scheduler] error cancelling ${eventId}: "Failed to cancel job"`,
    );
    logEventExecution({
      eventId,
      phase: "cancel",
      status: "failed",
      meta: { error: "Failed to cancel job" },
    });
    return;
  }
}

export async function scheduleEventCron(event: {
  id: string;
  scheduledAt: Date;
}) {
  const res = await scheduleCronJob(
    event.id,
    event.scheduledAt,
    "participant_event",
  );

  if (!res) {
    console.error(
      `[scheduler] error scheduling ${event.id}: "Failed to schedule event"`,
    );
    logEventExecution({
      eventId: event.id,
      phase: "schedule",
      status: "failed",
      meta: { error: "Failed to schedule event" },
    });
    return {
      scheduled: false as const,
    };
  }

  logEventExecution({
    eventId: event.id,
    phase: "schedule",
    status: "scheduled",
    meta: { runAt: event.scheduledAt.toISOString() },
  });

  if (event.scheduledAt.getTime() <= Date.now() + 1_000) {
    console.log(`[scheduler] running ${event.id} immediately`);
    void executeScheduledEvent(event.id);
    return {
      scheduled: true as const,
      runAt: event.scheduledAt,
      immediate: true as const,
    };
  }

  return {
    scheduled: true as const,
    runAt: event.scheduledAt,
    immediate: false as const,
  };
}

export async function scheduleDeployedEvents(
  events: Array<{ id: string; scheduledAt: Date }>,
  options?: {
    validate?: boolean;
    checkAttachments?: boolean;
    skipInvalid?: boolean;
  },
): Promise<DeployScheduleResult> {
  const fullEvents =
    options?.validate === false
      ? []
      : await prisma.event.findMany({
          where: { id: { in: events.map((event) => event.id) } },
        });

  const validation =
    options?.validate === false
      ? { ok: true, issues: [], blocking: [] }
      : await validateEventsForDeploy(fullEvents, {
          checkAttachments: options?.checkAttachments,
        });

  if (!validation.ok && !options?.skipInvalid) {
    return {
      scheduled: 0,
      immediate: 0,
      skipped: 0,
      validationIssues: validation.blocking,
      nextEventAt: null,
    };
  }

  const blockedIds = new Set(validation.blocking.map((issue) => issue.eventId));
  const schedulable = events.filter((event) => !blockedIds.has(event.id));
  const results = await Promise.all(
    schedulable.map((event) => scheduleEventCron(event)),
  );
  const skipped = results.filter((result: any) => !result.scheduled).length;
  const immediate = results.filter(
    (result: any) =>
      result.scheduled && "immediate" in result && result.immediate,
  ).length;
  const futureRuns = results
    .flatMap((result: any) =>
      result.scheduled &&
      "runAt" in result &&
      result.runAt.getTime() > Date.now()
        ? [result.runAt]
        : [],
    )
    .sort((a, b) => a.getTime() - b.getTime());

  if (skipped > 0) {
    await addNotificationForAdminsDeduped(
      {
        type: "event_failed",
        title: "Some events were not scheduled",
        message: `${skipped} event(s) were more than 2 hours overdue and were marked failed.`,
        meta: { skipped, reason: "overdue_grace_expired" },
      },
      `deploy_overdue_skipped:${schedulable.map((event) => event.id).join(",")}`,
    );
  }

  return {
    scheduled: results.filter((result: any) => result.scheduled).length,
    immediate,
    skipped,
    validationIssues: validation.issues,
    nextEventAt: futureRuns[0]?.toISOString() ?? null,
  };
}

export async function runEventNow(eventId: string) {
  await cancelEventCron(eventId, "auto");
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

function getTopOfNextHour(now = new Date()): Date {
  const date = new Date(now);
  date.setHours(date.getHours() + 1);
  date.setMinutes(0);
  date.setSeconds(0);
  date.setMilliseconds(0);
  return date;
}

export async function reconcileScheduledEventsOnBoot() {
  const now = new Date();

  // 1. Fetch active scheduled jobs from Supabase
  const supabaseJobs = await getActiveScheduledJobs();
  const supabaseJobMap = new Map(supabaseJobs.map((job) => [job.job_id, job]));

  // 2. Fetch local pending participant events
  let localEvents = [];
  try {
    localEvents = await prisma.event.findMany({
      where: {
        status: EventStatus.pending,
        OR: [
          { eventFlow: { deployedAt: { not: null } } },
          { cohortEventFlow: { deployedAt: { not: null } } },
        ],
      },
      select: { id: true, scheduledAt: true },
    });
  } catch (error) {
    return;
  }

  // Filter out participant events with null scheduledAt
  const validLocalEvents = localEvents.filter(
    (e): e is typeof e & { scheduledAt: Date } => e.scheduledAt !== null,
  );

  // 3. Fetch local pending/scheduled opportunity events
  const localOpportunityEvents = await prisma.opportunityEvent.findMany({
    where: {
      status: {
        in: [OpportunityEventStatus.pending, OpportunityEventStatus.scheduled],
      },
    },
    select: { id: true, cronJobId: true, scheduledAt: true },
  });

  let reconciledCount = 0;
  let skippedCount = 0;
  let rescheduledCount = 0;

  // 4. Process Participant Events
  for (const event of validLocalEvents) {
    const supabaseJob = supabaseJobMap.get(event.id);
    supabaseJobMap.delete(event.id); // Mark as not orphaned

    const dueTime = supabaseJob
      ? new Date(supabaseJob.due_at)
      : event.scheduledAt;
    const isOverdue = dueTime.getTime() <= now.getTime();
    const isPastGrace =
      isOverdue && now.getTime() - dueTime.getTime() > OVERDUE_GRACE_MS;

    if (isPastGrace) {
      // Overdue beyond grace period: reschedule to top of next hour
      const nextHour = getTopOfNextHour(now);
      await prisma.event.update({
        where: { id: event.id },
        data: { scheduledAt: nextHour },
      });
      await scheduleCronJob(event.id, nextHour, "participant_event");
      rescheduledCount++;
      reconciledCount++;
    } else if (!supabaseJob) {
      // Missing from Supabase: schedule/sync it
      await scheduleEventCron(event);
      reconciledCount++;
    }
  }

  // 5. Process Opportunity Events
  for (const oEvent of localOpportunityEvents) {
    const supabaseJob = supabaseJobMap.get(oEvent.cronJobId);
    supabaseJobMap.delete(oEvent.cronJobId); // Mark as not orphaned

    const dueTime = supabaseJob
      ? new Date(supabaseJob.due_at)
      : oEvent.scheduledAt;
    const isOverdue = dueTime.getTime() <= now.getTime();
    const isPastGrace =
      isOverdue && now.getTime() - dueTime.getTime() > OVERDUE_GRACE_MS;

    if (isPastGrace) {
      // Overdue beyond grace: reschedule to top of next hour
      const nextHour = getTopOfNextHour(now);
      await prisma.opportunityEvent.update({
        where: { id: oEvent.id },
        data: {
          scheduledAt: nextHour,
          status: OpportunityEventStatus.scheduled,
        },
      });
      await scheduleCronJob(oEvent.cronJobId, nextHour, "opportunity_event");
      rescheduledCount++;
      reconciledCount++;
    } else if (!supabaseJob) {
      // Missing from Supabase: schedule/sync it
      try {
        await scheduleOpportunityCron(oEvent);
        await prisma.opportunityEvent.update({
          where: { id: oEvent.id },
          data: { status: OpportunityEventStatus.scheduled },
        });
        reconciledCount++;
      } catch (err) {
        console.error(
          `[reconciler] Failed to schedule opportunity event ${oEvent.id}:`,
          err,
        );
        skippedCount++;
      }
    }
  }

  // 6. Clean up orphaned Supabase jobs
  for (const [jobId, job] of supabaseJobMap.entries()) {
    console.log(
      `[reconciler] Cancelling orphaned Supabase job: ${jobId} (${job.job_type})`,
    );
    const cancelled = await cancelScheduledJob(jobId, "cancelled");
    if (cancelled) {
      skippedCount++;
    }
  }

  logEventExecution({
    eventId: "boot-reconcile",
    phase: "schedule",
    status: "reconciled",
    meta: {
      totalParticipantEvents: validLocalEvents.length,
      totalOpportunityEvents: localOpportunityEvents.length,
      reconciled: reconciledCount,
      rescheduled: rescheduledCount,
      orphanedCancelled: supabaseJobMap.size,
      skipped: skippedCount,
    },
  });

  return {
    reconciled: reconciledCount,
    rescheduled: rescheduledCount,
    skipped: skippedCount,
  };
}

type EventFetchResult = {
  id: string;
  scheduledAt: Date | null;
  status: EventStatus;
};

export async function findDeployableEvents(filter: {
  programmeId?: string;
  cohortId?: string | null;
}): Promise<EventFetchResult[]> {
  try {
    const events = await prisma.event.findMany({
      where: {
        programmeId: filter.programmeId,
        cohortId: filter.cohortId,
        status: EventStatus.pending,
        OR: [
          { eventFlow: { deployedAt: { not: null } } },
          { cohortEventFlow: { deployedAt: { not: null } } },
        ],
      },
      select: { id: true, scheduledAt: true, status: true },
    });
    return events;
  } catch (error) {
    console.error("Error finding deployable events:", error);
    return [];
  }
}

export async function resetFailedEventsForDeploy(events: EventFetchResult[]) {
  for (const event of events) {
    if (event.status !== EventStatus.failed) {
      continue;
    }
    await prisma.event.update({
      where: { id: event.id },
      data: {
        status: EventStatus.pending,
        attemptCount: 0,
        lastAttemptAt: null,
        executionMetadata: {},
      },
    });
  }
}

export async function scheduleOnFlowSave(filter: {
  programmeId?: string;
  cohortId?: string;
}) {
  const events = await findDeployableEvents({
    programmeId: filter.programmeId,
    cohortId: filter.cohortId || null,
  });
  await resetFailedEventsForDeploy(events);

  const scheduleResult = await scheduleDeployedEvents(
    events
      .filter(
        (event): event is typeof event & { scheduledAt: Date } =>
          event.scheduledAt !== null,
      )
      .map((event) => ({
        id: event.id,
        scheduledAt: event.scheduledAt,
      })),
    { checkAttachments: false, skipInvalid: true },
  );

  logEventExecution({
    eventId: filter.programmeId
      ? `programme:${filter.programmeId}`
      : `cohort:${filter.cohortId}`,
    phase: "schedule",
    status: "flow_saved",
    meta: {
      eventCount: events.length,
      scheduled: scheduleResult.scheduled,
      immediate: scheduleResult.immediate,
      skipped: scheduleResult.skipped,
      nextEventAt: scheduleResult.nextEventAt,
      blocked:
        scheduleResult.validationIssues?.filter(
          (issue) => issue.errors.length > 0,
        ).length ?? 0,
    },
  });

  return {
    ok: true,
    ...scheduleResult,
  };
}
