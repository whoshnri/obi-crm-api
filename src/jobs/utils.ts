import type { Event, Prisma } from "@prisma/client";
import { sendAppScriptAuthEmail } from "../lib/email/app-script.js";
import { prisma } from "../lib/prisma.js";

export type EventConfigRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is EventConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEventConfig(config: Prisma.JsonValue): EventConfigRecord {
  return isRecord(config) ? config : {};
}

export function getStringConfig(config: EventConfigRecord, key: string) {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getNumberConfig(config: EventConfigRecord, key: string) {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function getLineItems(config: EventConfigRecord) {
  const value = config.lineItems;
  if (!Array.isArray(value)) return [];

  return value
    .filter(isRecord)
    .map((item) => ({
      description:
        typeof item.description === "string" && item.description.trim()
          ? item.description.trim()
          : "Programme fee",
      amount:
        typeof item.amount === "number" && Number.isFinite(item.amount)
          ? item.amount
          : 0,
      currency:
        typeof item.currency === "string" && item.currency.trim()
          ? item.currency.trim().toUpperCase()
          : undefined,
    }))
    .filter((item) => item.amount > 0);
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  fromName?: string,
) {
  try {
    await sendAppScriptAuthEmail({ to, subject, body, fromName });
  } catch (error) {
    console.log(
      "[email:auth:placeholder]",
      JSON.stringify({
        to,
        subject,
        bodyLength: body.length,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export async function sendAdminFeedback(input: {
  event: Pick<Event, "id" | "name" | "programmeId">;
  total: number;
  successCount: number;
  failureCount: number;
  errorMessage?: string;
}) {
  const admins = await prisma.admin.findMany({
    where: { notificationsEnabled: true },
    select: { email: true },
  });

  const link = `/programmes/${input.event.programmeId}/events/${input.event.id}/status`;
  const lines = [
    `Event: ${input.event.name}`,
    `Total participants: ${input.total}`,
    `Success count: ${input.successCount}`,
    `Failure count: ${input.failureCount}`,
    `Status: ${link}`,
  ];

  if (input.errorMessage) {
    lines.push(`Error: ${input.errorMessage}`);
  }

  await Promise.all(
    admins.map((admin) =>
      sendEmail(
        admin.email,
        `Event completed: ${input.event.name}`,
        lines.join("\n"),
      ),
    ),
  );
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function getEventRecipients(
  event: Pick<Event, "programmeId" | "cohortId">,
) {
  if (event.cohortId) {
    const cohortParticipants = await prisma.cohortParticipant.findMany({
      where: { cohortId: event.cohortId },
      include: { participant: true },
    });
    const programmeParticipants = await prisma.programmeParticipant.findMany({
      where: {
        programmeId: event.programmeId,
        participantId: {
          in: cohortParticipants.map((entry) => entry.participantId),
        },
      },
    });
    const programmeParticipantByParticipantId = new Map(
      programmeParticipants.map((entry) => [entry.participantId, entry]),
    );

    return cohortParticipants.map((entry) => ({
      participant: entry.participant,
      programmeParticipant:
        programmeParticipantByParticipantId.get(entry.participantId) ?? null,
    }));
  }

  const programmeParticipants = await prisma.programmeParticipant.findMany({
    where: { programmeId: event.programmeId },
    include: { participant: true },
  });

  return programmeParticipants.map((entry) => ({
    participant: entry.participant,
    programmeParticipant: entry,
  }));
}
