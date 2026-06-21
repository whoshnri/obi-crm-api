import { OpportunityEventStatus, type Prisma } from "@prisma/client";
import { cancelScheduledJob, scheduleCronJob, LogStatus } from "../jobs/scheduler.js";
import { buildAndSendOpportunityEmailBatch } from "./email/send-batch.js";
import {
  getVariableBindingsFromConfig,
  parseTemplateMetadata,
  validateVariableBindings,
} from "./email/template-variables.js";
import { renderTemplateWithBindings } from "./email/render.js";
import { withRetry } from "./events/retry.js";
import { HttpError } from "./http.js";
import { addNotificationForAdminsDeduped } from "./notifications.js";
import { logEventExecution } from "./observability/event-logger.js";
import { prisma } from "./prisma.js";
import {
  errorMessage,
  getStringConfig,
  parseEventConfig,
} from "../jobs/utils.js";

export function getOpportunityCronJobId(
  opportunityId: string,
  pipelineStepId: string,
) {
  return `obi-opportunity-${opportunityId}-${pipelineStepId}`;
}

async function resolveOpportunityEmailContent(event: {
  name: string;
  config: unknown;
}) {
  const config = parseEventConfig(event.config as Prisma.JsonValue);
  const templateId = getStringConfig(config, "templateId");

  if (templateId) {
    const template = await prisma.emailTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      throw new Error(`Email template ${templateId} was not found.`);
    }

    const metadata = parseTemplateMetadata(template.metadata);
    const bindings = getVariableBindingsFromConfig(
      config as Record<string, unknown>,
    );
    const validation = validateVariableBindings(
      metadata.variables ?? [],
      bindings,
    );
    if (!validation.valid) {
      throw new Error(
        `Missing variable bindings: ${validation.missing.join(", ")}`,
      );
    }

    return {
      subject: template.subject,
      bodyHtml: template.body,
      fromName:
        getStringConfig(config, "fromName") ?? template.fromName ?? undefined,
      attachments: metadata.attachments ?? [],
      buttons: metadata.buttons ?? [],
      bindings,
    };
  }

  return {
    subject: getStringConfig(config, "subject") ?? event.name,
    bodyHtml: getStringConfig(config, "body") ?? "",
    fromName: getStringConfig(config, "fromName"),
    attachments: [],
    buttons: [],
    bindings: {},
  };
}

export async function executeOpportunityEvent(
  eventId: string,
  options?: { force?: boolean },
) {
  const startedAt = Date.now();
  const event = await prisma.opportunityEvent.findUnique({
    where: { id: eventId },
    include: {
      opportunity: true,
    },
  });

  if (!event || event.status !== OpportunityEventStatus.scheduled) return;
  if (!options?.force && event.scheduledAt > new Date()) return;

  const claimResult = await prisma.opportunityEvent.updateMany({
    where: {
      id: eventId,
      status: OpportunityEventStatus.scheduled,
    },
    data: {
      status: OpportunityEventStatus.completed,
    },
  });

  if (claimResult.count === 0) return;
  try {
    const content = await resolveOpportunityEmailContent(event);

    if (!content.bodyHtml.trim()) {
      throw new Error("Opportunity email event is missing body content.");
    }

    const context = {
      participant: {
        name: event.opportunity.name,
        email: event.opportunity.email,
        organisation: event.opportunity.organisation ?? "",
        id: event.opportunity.id,
      },
    };

    const renderedSubject = renderTemplateWithBindings(
      content.subject,
      content.bindings,
      context,
    );
    const renderedBody = renderTemplateWithBindings(
      content.bodyHtml,
      content.bindings,
      context,
    );

    await withRetry(
      `opportunity-email:${event.id}`,
      async () =>
        buildAndSendOpportunityEmailBatch({
          to: event.opportunity.email,
          toName: event.opportunity.name,
          fromName: content.fromName,
          subject: renderedSubject,
          bodyHtml: renderedBody,
          attachments: content.attachments,
          buttons: content.buttons,
          context,
        }),
      { eventId: event.id, maxAttempts: 3 },
    );

    await prisma.opportunityEvent.update({
      where: { id: event.id },
      data: {
        status: OpportunityEventStatus.completed,
        completedAt: new Date(),
        error: null,
      },
    });

    await cancelOpportunityCron(event.cronJobId, "completed");

    logEventExecution({
      eventId: event.id,
      phase: "complete",
      status: "completed",
      durationMs: Date.now() - startedAt,
      meta: { opportunityId: event.opportunityId, type: "opportunity" },
    });
  } catch (error) {
    const message = errorMessage(error);
    await prisma.opportunityEvent.update({
      where: { id: event.id },
      data: {
        status: OpportunityEventStatus.failed,
        error: message,
      },
    });

    logEventExecution({
      eventId: event.id,
      phase: "fail",
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: message,
      meta: { opportunityId: event.opportunityId, type: "opportunity" },
    });

    await addNotificationForAdminsDeduped(
      {
        type: "event_failed",
        title: "Opportunity email failed",
        message: `Opportunity event "${event.name}" failed: ${message}`,
        meta: {
          opportunityEventId: event.id,
          opportunityId: event.opportunityId,
          error: message,
        },
      },
      `opportunity_failed:${event.id}`,
    );

    await cancelOpportunityCron(event.cronJobId, "failed");
  }
}

export async function scheduleOpportunityCron(event: {
  id: string;
  cronJobId: string;
  scheduledAt: Date;
}) {
  const res = await scheduleCronJob(
    event.cronJobId,
    event.scheduledAt,
    "opportunity_event",
  );

  if (!res) {
    throw new Error("Failed to schedule opportunity event");
  }
}

export async function cancelOpportunityCron(cronJobId: string, status?: LogStatus) {
  const res = await cancelScheduledJob(cronJobId, status);
  return res;
}

export async function runOpportunityEventNow(eventId: string) {
  const event = await prisma.opportunityEvent.findUnique({
    where: { id: eventId },
  });
  if (!event) {
    throw new HttpError("Event not found.", 404);
  }
  if (event.status === OpportunityEventStatus.completed) {
    throw new HttpError("Completed events cannot be run again.", 409);
  }
  if (event.status === OpportunityEventStatus.cancelled) {
    throw new HttpError(
      "Cancelled events cannot be run. Re-apply a pipeline to schedule a new event.",
      409,
    );
  }

  const isCancelled = await cancelOpportunityCron(event.cronJobId, "cancelled");
  if (!isCancelled) {
    throw new Error("Failed to cancel opportunity event");
  }
  await prisma.opportunityEvent.update({
    where: { id: eventId },
    data: {
      status: OpportunityEventStatus.scheduled,
      scheduledAt: new Date(Date.now() - 1000),
      error: null,
      cancelledAt: null,
      completedAt: null,
    },
  });

  await executeOpportunityEvent(eventId, { force: true });

  return prisma.opportunityEvent.findUnique({ where: { id: eventId } });
}
