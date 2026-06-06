import type { Event, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const EVENT_SCHEDULE_HASH = "event_schedule";
export const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export type EventConfigRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is EventConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEventConfig(config: Prisma.JsonValue): EventConfigRecord {
  return isRecord(config) ? config : {};
}

export function isWithinScheduleWindow(isoTimestamp: string, now = new Date()) {
  const scheduledTime = new Date(isoTimestamp).getTime();
  if (Number.isNaN(scheduledTime)) return false;
  return Math.abs(scheduledTime - now.getTime()) <= FIFTEEN_MINUTES_MS;
}

export function getStringConfig(config: EventConfigRecord, key: string) {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getNumberConfig(config: EventConfigRecord, key: string) {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function getLineItems(config: EventConfigRecord) {
  const value = config.lineItems;
  if (!Array.isArray(value)) return [];

  return value
    .filter(isRecord)
    .map((item) => ({
      description: typeof item.description === "string" && item.description.trim() ? item.description.trim() : "Programme fee",
      amount: typeof item.amount === "number" && Number.isFinite(item.amount) ? item.amount : 0,
      currency: typeof item.currency === "string" && item.currency.trim() ? item.currency.trim().toUpperCase() : undefined
    }))
    .filter((item) => item.amount > 0);
}

export async function sendEmail(to: string, subject: string, body: string) {
  console.log("[email:placeholder]", JSON.stringify({ to, subject, bodyLength: body.length }));
}

export async function sendAdminFeedback(input: {
  event: Pick<Event, "id" | "name" | "programmeId">;
  total: number;
  successCount: number;
  failureCount: number;
}) {
  const admins = await prisma.admin.findMany({
    where: { notificationsEnabled: true },
    select: { email: true }
  });

  const link = `/programmes/${input.event.programmeId}/events/${input.event.id}/status`;
  await Promise.all(
    admins.map((admin) =>
      sendEmail(
        admin.email,
        `Event completed: ${input.event.name}`,
        [
          `Event: ${input.event.name}`,
          `Total participants: ${input.total}`,
          `Success count: ${input.successCount}`,
          `Failure count: ${input.failureCount}`,
          `Status: ${link}`
        ].join("\n")
      )
    )
  );
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function getEventRecipients(event: Pick<Event, "programmeId" | "cohortId">) {
  if (event.cohortId) {
    const cohortParticipants = await prisma.cohortParticipant.findMany({
      where: { cohortId: event.cohortId },
      include: { participant: true }
    });
    const programmeParticipants = await prisma.programmeParticipant.findMany({
      where: {
        programmeId: event.programmeId,
        participantId: { in: cohortParticipants.map((entry) => entry.participantId) }
      }
    });
    const programmeParticipantByParticipantId = new Map(
      programmeParticipants.map((entry) => [entry.participantId, entry])
    );

    return cohortParticipants.map((entry) => ({
      participant: entry.participant,
      programmeParticipant: programmeParticipantByParticipantId.get(entry.participantId) ?? null
    }));
  }

  const programmeParticipants = await prisma.programmeParticipant.findMany({
    where: { programmeId: event.programmeId },
    include: { participant: true }
  });

  return programmeParticipants.map((entry) => ({
    participant: entry.participant,
    programmeParticipant: entry
  }));
}
