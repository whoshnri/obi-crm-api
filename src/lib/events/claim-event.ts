import { EventStatus, Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { logEventExecution } from "../observability/event-logger.js";

export type ClaimedEvent = {
  id: string;
  programmeId: string;
  cohortId: string | null;
  baseType: string;
  attemptCount: number;
};

export async function claimEventForExecution(eventId: string): Promise<ClaimedEvent | null> {
  const result = await prisma.event.updateMany({
    where: {
      id: eventId,
      status: EventStatus.pending
    },
    data: {
      status: EventStatus.processing,
      lastAttemptAt: new Date(),
      attemptCount: { increment: 1 }
    }
  });

  if (result.count === 0) {
    logEventExecution({
      eventId,
      phase: "claim",
      status: "skipped",
      meta: { reason: "not_pending_or_already_claimed" }
    });
    return null;
  }

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      programmeId: true,
      cohortId: true,
      baseType: true,
      attemptCount: true
    }
  });

  if (!event) return null;

  logEventExecution({
    eventId: event.id,
    programmeId: event.programmeId,
    cohortId: event.cohortId,
    baseType: event.baseType,
    phase: "claim",
    status: "processing",
    attemptCount: event.attemptCount
  });

  return event;
}

export async function releaseEventClaim(eventId: string, status: EventStatus, metadata?: Prisma.InputJsonValue) {
  await prisma.event.update({
    where: { id: eventId },
    data: {
      status,
      ...(metadata !== undefined ? { executionMetadata: metadata } : {})
    }
  });
}

export async function mergeEventExecutionMetadata(eventId: string, patch: Record<string, unknown>) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { executionMetadata: true }
  });

  const current =
    event?.executionMetadata && typeof event.executionMetadata === "object" && !Array.isArray(event.executionMetadata)
      ? (event.executionMetadata as Record<string, unknown>)
      : {};

  await prisma.event.update({
    where: { id: eventId },
    data: {
      executionMetadata: {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString()
      } as Prisma.InputJsonValue
    }
  });
}
