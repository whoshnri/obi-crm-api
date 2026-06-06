import { EventBaseType, EventStatus, Prisma, StepStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { redis, withRedisFallback } from "../lib/redis.js";
import { scheduleCronJob } from "./scheduler.js";
import {
  EVENT_SCHEDULE_HASH,
  errorMessage,
  getEventRecipients,
  getLineItems,
  getNumberConfig,
  getStringConfig,
  isWithinScheduleWindow,
  parseEventConfig,
  sendAdminFeedback
} from "./utils.js";

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
  console.log("[invoice:job:stub]", JSON.stringify({
    eventId: data.eventId,
    programmeId: data.programmeId,
    participantId: data.participantId,
    programmeParticipantId: data.programmeParticipantId,
    stripeCustomerId: data.stripeCustomerId,
    amount: data.amount,
    currency: data.currency,
    daysUntilDue: data.daysUntilDue,
    lineItems: data.lineItems
  }));

  return { participantId: data.participantId };
}

async function processInvoiceEvent(eventId: string) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: {
      programme: true
    }
  });

  if (!event || event.baseType !== EventBaseType.send_invoice || event.status !== EventStatus.pending) return;

  const config = parseEventConfig(event.config);
  const daysUntilDue = getNumberConfig(config, "daysUntilDue") ?? getNumberConfig(config, "days_until_due") ?? 7;
  const currency = (getStringConfig(config, "currency") ?? "GBP").toUpperCase();
  const configuredLineItems = getLineItems(config);
  const amount = getNumberConfig(config, "amount") ?? configuredLineItems.reduce((total, item) => total + item.amount, 0);

  if (amount <= 0) throw new Error(`Invoice event ${event.id} requires a positive amount`);

  await prisma.event.update({ where: { id: event.id }, data: { status: EventStatus.processing } });

  const recipients = await getEventRecipients(event);
  const jobs: Array<Promise<unknown>> = [];
  for (const { participant, programmeParticipant } of recipients) {
    if (!participant.stripeCustomerId) {
      const message = "Participant is missing stripeCustomerId";
      console.error("[invoice:event:participant:error]", JSON.stringify({ eventId: event.id, participantId: participant.id, message }));
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
      console.error("[invoice:event:participant:error]", JSON.stringify({ eventId: event.id, participantId: participant.id, message }));
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
      processInvoiceJob({
        eventId: event.id,
        programmeId: event.programmeId,
        programmeName: event.programme.name,
        participantId: participant.id,
        programmeParticipantId: programmeParticipant.id,
        stripeCustomerId: participant.stripeCustomerId,
        amount,
        currency,
        daysUntilDue,
        lineItems: configuredLineItems.length
          ? configuredLineItems.map((item) => ({ ...item, currency: item.currency ?? currency }))
          : [{ description: event.programme.name, amount, currency }]
      })
    );
  }

  const results = await Promise.allSettled(jobs);
  const failureCount = results.filter((result) => result.status === "rejected").length + (recipients.length - jobs.length);
  const successCount = recipients.length - failureCount;

  await prisma.event.update({
    where: { id: event.id },
    data: { status: failureCount === 0 ? EventStatus.completed : EventStatus.failed }
  });

  if (failureCount === 0) {
    await withRedisFallback(() => redis.hdel(EVENT_SCHEDULE_HASH, event.id), 0);
  }

  await sendAdminFeedback({
    event,
    total: recipients.length,
    successCount,
    failureCount
  });
}

export async function runSendInvoiceCronTick() {
  try {
    const scheduledEvents = await withRedisFallback(() => redis.hgetall(EVENT_SCHEDULE_HASH), {} as Record<string, string>);
    const matchedEventIds = (Object.entries(scheduledEvents) as Array<[string, string]>)
      .filter(([, scheduledAt]) => isWithinScheduleWindow(scheduledAt))
      .map(([eventId]) => eventId);

    await Promise.all(
      matchedEventIds.map(async (eventId) => {
        try {
          const event = await prisma.event.findUnique({ where: { id: eventId }, select: { baseType: true, status: true } });
          if (!event || event.baseType !== EventBaseType.send_invoice) {
            await withRedisFallback(() => redis.hdel(EVENT_SCHEDULE_HASH, eventId), 0);
            return;
          }

          if (event.status !== EventStatus.pending) {
            await withRedisFallback(() => redis.hdel(EVENT_SCHEDULE_HASH, eventId), 0);
            return;
          }

          await processInvoiceEvent(eventId);
        } catch (error) {
          console.error("[invoice:cron:event:error]", JSON.stringify({ eventId, message: errorMessage(error) }));
        }
      })
    );
  } catch (error) {
    console.error("[invoice:cron:error]", JSON.stringify({ message: errorMessage(error) }));
  }
}

export async function runSendInvoiceEventNow(eventId: string) {
  return processInvoiceEvent(eventId);
}

export function startSendInvoiceCron() {
  scheduleCronJob("obi-send-invoice", "0 15,45 * * * *", () => {
    void runSendInvoiceCronTick();
  });
}
