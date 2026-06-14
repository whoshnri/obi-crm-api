import { EventBaseType, EventStatus, Prisma, StepStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { claimEventForExecution, mergeEventExecutionMetadata } from "../lib/events/claim-event.js";
import {
  buildDependencyMetadata,
  loadParentEventStatus
} from "../lib/events/dependency-metadata.js";
import { withRetry } from "../lib/events/retry.js";
import { addNotificationForAdminsDeduped } from "../lib/notifications.js";
import { logEventExecution } from "../lib/observability/event-logger.js";
import {
  errorMessage,
  getEventRecipients,
  getNumberConfig,
  getStringConfig,
  parseEventConfig,
  sendAdminFeedback
} from "./utils.js";
import { invoiceAmountErrorMessage, resolveInvoiceAmount } from "../lib/invoices/resolve-amount.js";

type InvoiceLineItem = {
  description: string;
  amount: number;
  currency?: string;
};

type InvoiceExecutionJob = {
  eventId: string;
  programmeId: string;
  programmeName: string;
  participantId: string;
  programmeParticipantId: string;
  stripeCustomerId: string;
  amount: number;
  currency: string;
  daysUntilDue: number;
  lineItems: InvoiceLineItem[];
};

async function processInvoiceJob(data: InvoiceExecutionJob) {
  console.log(
    `[invoice] stub send — ${data.currency} ${data.amount} to participant ${data.participantId}`,
  );

  return { participantId: data.participantId };
}

async function failInvoiceEvent(
  event: { id: string; programmeId: string; cohortId: string | null; baseType: string; attemptCount: number },
  dependencyMetadata: Record<string, unknown>,
  message: string,
  startedAt: number,
) {
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
        failedAt: new Date().toISOString(),
      } as Prisma.InputJsonValue,
    },
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
  });

  await addNotificationForAdminsDeduped(
    {
      type: "event_failed",
      title: "Event failed",
      message: `Invoice event failed: ${message}`,
      meta: { eventId: event.id, programmeId: event.programmeId, error: message },
    },
    `event_failed:${event.id}`,
  );
}

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

export async function executeInvoiceEvent(eventId: string) {
  const startedAt = Date.now();
  const claimed = await claimEventForExecution(eventId);
  if (!claimed) return;

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: { programme: true }
  });

  if (!event || event.baseType !== EventBaseType.send_invoice) {
    await failInvoiceEvent(
      claimed,
      {},
      "Invoice event is missing or has the wrong type.",
      startedAt,
    );
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

  const config = parseEventConfig(event.config);
  const daysUntilDue = getNumberConfig(config, "daysUntilDue") ?? getNumberConfig(config, "days_until_due") ?? 7;
  const currency = (getStringConfig(config, "currency") ?? "GBP").toUpperCase();
  const amount = resolveInvoiceAmount(event.programme);

  if (amount === null) {
    await failInvoiceEvent(
      event,
      dependencyMetadata,
      invoiceAmountErrorMessage(),
      startedAt,
    );
    return;
  }

  try {
    const recipients = await getEventRecipients(event);

    if (recipients.length === 0) {
      await failInvoiceEvent(
        event,
        dependencyMetadata,
        "No enrolled participants to invoice.",
        startedAt,
      );
      return;
    }

    const jobs: Array<Promise<unknown>> = [];

    for (const { participant, programmeParticipant } of recipients) {
      if (!participant.stripeCustomerId) {
        const message = "Participant is missing stripeCustomerId";
        await prisma.eventParticipantStatus.upsert({
          where: { eventId_participantId: { eventId: event.id, participantId: participant.id } },
          create: {
            eventId: event.id,
            participantId: participant.id,
            status: StepStatus.not_sent,
            metadata: { error: message } as Prisma.InputJsonValue
          },
          update: {
            status: StepStatus.not_sent,
            metadata: { error: message } as Prisma.InputJsonValue
          }
        });
        continue;
      }

      if (!programmeParticipant) {
        const message = "Participant is not enrolled in the programme for this event";
        await prisma.eventParticipantStatus.upsert({
          where: { eventId_participantId: { eventId: event.id, participantId: participant.id } },
          create: {
            eventId: event.id,
            participantId: participant.id,
            status: StepStatus.not_sent,
            metadata: { error: message } as Prisma.InputJsonValue
          },
          update: {
            status: StepStatus.not_sent,
            metadata: { error: message } as Prisma.InputJsonValue
          }
        });
        continue;
      }

      jobs.push(
        withRetry(
          `invoice:${participant.id}`,
          async () =>
            processInvoiceJob({
              eventId: event.id,
              programmeId: event.programmeId,
              programmeName: event.programme.name,
              participantId: participant.id,
              programmeParticipantId: programmeParticipant.id,
              stripeCustomerId: participant.stripeCustomerId!,
              amount,
              currency,
              daysUntilDue,
              lineItems: [{ description: `${event.programme.name} fee`, amount, currency }],
            }),
          { eventId: event.id, maxAttempts: 2 }
        )
      );
    }

    const results = await Promise.allSettled(jobs);
    const skippedCount = recipients.length - jobs.length;
    const failureCount = results.filter((result) => result.status === "rejected").length + skippedCount;
    const successCount = recipients.length - failureCount;
    const durationMs = Date.now() - startedAt;

    if (jobs.length === 0) {
      await failInvoiceEvent(
        event,
        {
          ...dependencyMetadata,
          recipientCount: recipients.length,
          failureCount: skippedCount,
        },
        "No participants have a Stripe customer ID. Add Stripe customers before sending invoices.",
        startedAt,
      );
      return;
    }

    const errorMessage =
      skippedCount > 0
        ? `${skippedCount} participant(s) skipped (missing Stripe customer or enrolment).`
        : undefined;

    await prisma.event.update({
      where: { id: event.id },
      data: {
        status: failureCount === 0 ? EventStatus.completed : EventStatus.failed,
        executionMetadata: {
          ...dependencyMetadata,
          lastPhase: failureCount === 0 ? "completed" : "failed",
          recipientCount: recipients.length,
          successCount,
          failureCount,
          durationMs,
          ...(errorMessage ? { error: errorMessage } : {}),
        } as Prisma.InputJsonValue
      }
    });

    logEventExecution({
      eventId: event.id,
      programmeId: event.programmeId,
      cohortId: event.cohortId,
      baseType: event.baseType,
      phase: failureCount === 0 ? "complete" : "fail",
      status: failureCount === 0 ? "completed" : "failed",
      recipientCount: recipients.length,
      durationMs,
      attemptCount: event.attemptCount,
      error: failureCount === 0 ? undefined : errorMessage ?? `${failureCount} invoice(s) failed`,
    });

    await sendAdminFeedback({ event, total: recipients.length, successCount, failureCount });

    await addNotificationForAdminsDeduped(
      {
        type: failureCount === 0 ? "event_completed" : "event_failed",
        title: failureCount === 0 ? "Event completed" : "Event failed",
        message:
          failureCount === 0
            ? `Invoice event ${event.name} completed successfully.`
            : `Invoice event ${event.name} completed with ${failureCount} failure(s).`,
        meta: { eventId: event.id, programmeId: event.programmeId, failureCount, successCount }
      },
      `${failureCount === 0 ? "event_completed" : "event_failed"}:${event.id}`
    );
  } catch (error) {
    const message = errorMessage(error);
    await failInvoiceEvent(event, dependencyMetadata, message, startedAt);
  }
}

export async function runSendInvoiceEventNow(eventId: string) {
  return executeInvoiceEvent(eventId);
}
