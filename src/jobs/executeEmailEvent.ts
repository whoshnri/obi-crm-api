import { EventStatus, Prisma, StepStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  buildAndSendProgrammeEmailBatch,
  loadEmailTemplateForEvent
} from "../lib/email/send-batch.js";
import { claimEventForExecution, mergeEventExecutionMetadata } from "../lib/events/claim-event.js";
import {
  buildDependencyMetadata,
  dependencyMetadataToJson,
  loadParentEventStatus
} from "../lib/events/dependency-metadata.js";
import { withRetry } from "../lib/events/retry.js";
import { addNotificationForAdminsDeduped } from "../lib/notifications.js";
import { logEventExecution } from "../lib/observability/event-logger.js";
import { errorMessage, sendAdminFeedback } from "./utils.js";

async function loadFlowMap(event: {
  eventFlowId: string | null;
  cohortEventFlowId: string | null;
}) {
  if (event.eventFlowId) {
    const flow = await prisma.eventFlow.findUnique({
      where: { id: event.eventFlowId },
      select: { flow: true }
    });
    return flow?.flow && typeof flow.flow === "object" && !Array.isArray(flow.flow)
      ? (flow.flow as Record<string, string>)
      : {};
  }

  if (event.cohortEventFlowId) {
    const flow = await prisma.cohortEventFlow.findUnique({
      where: { id: event.cohortEventFlowId },
      select: { flow: true }
    });
    return flow?.flow && typeof flow.flow === "object" && !Array.isArray(flow.flow)
      ? (flow.flow as Record<string, string>)
      : {};
  }

  return {};
}

export async function executeEmailEvent(eventId: string) {
  const startedAt = Date.now();
  const claimed = await claimEventForExecution(eventId);
  if (!claimed) return;

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: { programme: true }
  });

  if (!event || event.baseType !== "send_email") {
    return;
  }

  const flow = await loadFlowMap(event);
  const parent = await loadParentEventStatus(flow[event.id] ?? null);
  const dependencyMetadata = buildDependencyMetadata({
    event,
    flow,
    parentStatus: parent?.status ?? null
  });

  await mergeEventExecutionMetadata(event.id, {
    ...dependencyMetadata,
    lastPhase: "processing"
  });

  try {
    const template = await loadEmailTemplateForEvent(event);

    const { recipients } = await withRetry(
      "programme-email-batch",
      async () => buildAndSendProgrammeEmailBatch({ event, template }),
      { maxAttempts: 3, eventId: event.id }
    );

    await Promise.all(
      recipients.map(({ participant }) =>
        prisma.eventParticipantStatus.upsert({
          where: {
            eventId_participantId: {
              eventId: event.id,
              participantId: participant.id
            }
          },
          create: {
            eventId: event.id,
            participantId: participant.id,
            status: StepStatus.sent,
            metadata: {}
          },
          update: {
            status: StepStatus.sent,
            metadata: {}
          }
        })
      )
    );

    const durationMs = Date.now() - startedAt;
    await prisma.event.update({
      where: { id: event.id },
      data: {
        status: EventStatus.completed,
        executionMetadata: {
          ...dependencyMetadata,
          lastPhase: "completed",
          recipientCount: recipients.length,
          durationMs,
          completedAt: new Date().toISOString()
        } as Prisma.InputJsonValue
      }
    });

    logEventExecution({
      eventId: event.id,
      programmeId: event.programmeId,
      cohortId: event.cohortId,
      baseType: event.baseType,
      phase: "complete",
      status: "completed",
      recipientCount: recipients.length,
      durationMs,
      attemptCount: event.attemptCount,
      meta: dependencyMetadata
    });

    await sendAdminFeedback({
      event,
      total: recipients.length,
      successCount: recipients.length,
      failureCount: 0
    });

    await addNotificationForAdminsDeduped(
      {
        type: "event_completed",
        title: "Event completed",
        message: `Event ${event.name} completed successfully.`,
        meta: { eventId: event.id, programmeId: event.programmeId, recipientCount: recipients.length }
      },
      `event_completed:${event.id}`
    );
  } catch (error) {
    const message = errorMessage(error);
    const durationMs = Date.now() - startedAt;

    await prisma.event.update({
      where: { id: event.id },
      data: {
        status: EventStatus.failed,
        executionMetadata: {
          ...dependencyMetadata,
          lastPhase: "failed",
          error: message,
          durationMs,
          failedAt: new Date().toISOString()
        } as Prisma.InputJsonValue
      }
    });

    logEventExecution({
      eventId: event.id,
      programmeId: event.programmeId,
      cohortId: event.cohortId,
      baseType: event.baseType,
      phase: "fail",
      status: "failed",
      durationMs,
      attemptCount: event.attemptCount,
      error: message,
      meta: dependencyMetadata
    });

    await addNotificationForAdminsDeduped(
      {
        type: "event_failed",
        title: "Event failed",
        message: `Event ${event.name} failed: ${message}`,
        meta: { eventId: event.id, programmeId: event.programmeId, error: message }
      },
      `event_failed:${event.id}`
    );

    await sendAdminFeedback({
      event,
      total: 0,
      successCount: 0,
      failureCount: 1,
      errorMessage: message
    });
  }
}

export async function runSendEmailEventNow(eventId: string) {
  return executeEmailEvent(eventId);
}
