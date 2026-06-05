import { Bunqueue, type Job } from "bunqueue/client";
import { EventBaseType, EventStatus, InvoiceStatus, PaymentStatus, Prisma, StepStatus } from "../generated/client";
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
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
} from "./utils";

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

type InvoiceDbRetryJob = {
  stripeInvoiceId: string;
  stripeInvoiceUrl?: string | null;
  programmeId: string;
  participantId: string;
  programmeParticipantId?: string;
  amount: number;
  currency: string;
  dueDate: string;
  lineItems: InvoiceLineItem[];
};

type InvoiceJobResult = {
  participantId: string;
};

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

async function writeParticipantInvoice(input: InvoiceDbRetryJob) {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.participantInvoice.upsert({
      where: {
        programmeId_participantId: {
          programmeId: input.programmeId,
          participantId: input.participantId
        }
      },
      create: {
        programmeId: input.programmeId,
        participantId: input.participantId,
        amount: input.amount,
        currency: input.currency,
        status: InvoiceStatus.sent,
        dueDate: new Date(input.dueDate),
        stripeInvoiceId: input.stripeInvoiceId,
        stripeInvoiceUrl: input.stripeInvoiceUrl,
        lineItems: input.lineItems as unknown as Prisma.InputJsonValue
      },
      update: {
        amount: input.amount,
        currency: input.currency,
        status: InvoiceStatus.sent,
        dueDate: new Date(input.dueDate),
        stripeInvoiceId: input.stripeInvoiceId,
        stripeInvoiceUrl: input.stripeInvoiceUrl,
        lineItems: input.lineItems as unknown as Prisma.InputJsonValue
      }
    });

    await tx.programmeParticipant.updateMany({
      where: input.programmeParticipantId
        ? { id: input.programmeParticipantId }
        : { programmeId: input.programmeId, participantId: input.participantId },
      data: {
        invoiceId: invoice.id,
        paymentStatus: PaymentStatus.invoiced
      }
    });

    return invoice;
  });
}

async function processInvoiceJob(job: Job<InvoiceExecutionJob>): Promise<InvoiceJobResult> {
  const data = job.data;
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

export const invoiceDbRetryQueue = new Bunqueue<InvoiceDbRetryJob, { invoiceId: string }>("invoice-db-retry", {
  embedded: true,
  concurrency: 2,
  processor: async (job) => {
    const invoice = await writeParticipantInvoice(job.data);
    return { invoiceId: invoice.id };
  }
});

export const invoiceExecutionQueue = new Bunqueue<InvoiceExecutionJob, InvoiceJobResult>("invoice-execution", {
  embedded: true,
  concurrency: 5,
  processor: processInvoiceJob
});

async function waitForJob(job: Job<InvoiceExecutionJob>, timeoutMs = 5 * 60 * 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await job.getState();
    if (state === "completed") return { ok: true };
    if (state === "failed") {
      const freshJob = await invoiceExecutionQueue.getJob(job.id);
      return { ok: false, error: freshJob?.failedReason ?? "Invoice job failed" };
    }
    await Bun.sleep(500);
  }
  return { ok: false, error: "Invoice job timed out" };
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
  const jobs = [];
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
      await invoiceExecutionQueue.add(
        "send-invoice",
        {
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
        },
        { durable: true, attempts: 1 }
      )
    );
  }

  const results = await Promise.all(jobs.map(waitForJob));
  const failureCount = results.filter((result) => !result.ok).length + (recipients.length - jobs.length);
  const successCount = recipients.length - failureCount;

  await prisma.event.update({
    where: { id: event.id },
    data: { status: failureCount === 0 ? EventStatus.completed : EventStatus.failed }
  });

  if (failureCount === 0) {
    await redis.hdel(EVENT_SCHEDULE_HASH, event.id);
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
    const scheduledEvents = await redis.hgetall(EVENT_SCHEDULE_HASH);
    const matchedEventIds = (Object.entries(scheduledEvents) as Array<[string, string]>)
      .filter(([, scheduledAt]) => isWithinScheduleWindow(scheduledAt))
      .map(([eventId]) => eventId);

    await Promise.all(
      matchedEventIds.map(async (eventId) => {
        try {
          const event = await prisma.event.findUnique({ where: { id: eventId }, select: { baseType: true, status: true } });
          if (!event || event.baseType !== EventBaseType.send_invoice) {
            await redis.hdel(EVENT_SCHEDULE_HASH, eventId);
            return;
          }

          if (event.status !== EventStatus.pending) {
            await redis.hdel(EVENT_SCHEDULE_HASH, eventId);
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
  Bun.cron("15,45 * * * *", () => {
    void runSendInvoiceCronTick();
  });
}
