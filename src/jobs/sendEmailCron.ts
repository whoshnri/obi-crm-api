import { EventBaseType, EventStatus, Prisma, StepStatus } from "../generated/client";
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import {
  EVENT_SCHEDULE_HASH,
  errorMessage,
  getStringConfig,
  isWithinScheduleWindow,
  parseEventConfig,
  sendAdminFeedback,
  sendEmail
} from "./utils";

async function processEmailEvent(eventId: string) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: {
      programme: {
        include: {
          participants: { include: { participant: true } }
        }
      }
    }
  });

  if (!event || event.baseType !== EventBaseType.send_email || event.status !== EventStatus.pending) return;

  const config = parseEventConfig(event.config);
  const templateId = getStringConfig(config, "templateId");
  if (!templateId) throw new Error(`Email event ${event.id} is missing config.templateId`);

  const template = await prisma.emailTemplate.findUnique({ where: { id: templateId } });
  if (!template) throw new Error(`Email template ${templateId} was not found`);

  await prisma.event.update({ where: { id: event.id }, data: { status: EventStatus.processing } });

  const results = await Promise.allSettled(
    event.programme.participants.map(async (programmeParticipant) => {
      const participant = programmeParticipant.participant;
      try {
        await sendEmail(participant.email, template.subject, template.body);
        await prisma.eventParticipantStatus.upsert({
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
        });
      } catch (error) {
        const message = errorMessage(error);
        console.error("[email:event:participant:error]", JSON.stringify({ eventId: event.id, participantId: participant.id, message }));
        await prisma.eventParticipantStatus.upsert({
          where: {
            eventId_participantId: {
              eventId: event.id,
              participantId: participant.id
            }
          },
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
        throw error;
      }
    })
  );

  const failureCount = results.filter((result) => result.status === "rejected").length;
  const successCount = results.length - failureCount;

  await prisma.event.update({
    where: { id: event.id },
    data: { status: failureCount === 0 ? EventStatus.completed : EventStatus.failed }
  });

  if (failureCount === 0) {
    await redis.hdel(EVENT_SCHEDULE_HASH, event.id);
  }

  await sendAdminFeedback({
    event,
    total: results.length,
    successCount,
    failureCount
  });
}

export async function runSendEmailCronTick() {
  try {
    const scheduledEvents = await redis.hgetall(EVENT_SCHEDULE_HASH);
    const matchedEventIds = (Object.entries(scheduledEvents) as Array<[string, string]>)
      .filter(([, scheduledAt]) => isWithinScheduleWindow(scheduledAt))
      .map(([eventId]) => eventId);

    await Promise.all(
      matchedEventIds.map(async (eventId) => {
        try {
          const event = await prisma.event.findUnique({ where: { id: eventId }, select: { baseType: true, status: true } });
          if (!event || event.baseType !== EventBaseType.send_email || event.status !== EventStatus.pending) return;
          await processEmailEvent(eventId);
        } catch (error) {
          console.error("[email:cron:event:error]", JSON.stringify({ eventId, message: errorMessage(error) }));
        }
      })
    );
  } catch (error) {
    console.error("[email:cron:error]", JSON.stringify({ message: errorMessage(error) }));
  }
}

export function startSendEmailCron() {
  Bun.cron("*/30 * * * *", () => {
    void runSendEmailCronTick();
  });
}
