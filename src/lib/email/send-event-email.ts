import type { Prisma } from "../../generated/client";
import { sendAppScriptEmail } from "./app-script";
import { renderEmailTemplate } from "./render";

type EventConfig = {
  subject?: unknown;
  body?: unknown;
  fromName?: unknown;
  recipientType?: unknown;
  recipientIds?: unknown;
};

type ParticipantRecord = {
  id: string;
  name: string;
  email: string;
  organisation: string | null;
  address: string | null;
  phone: string | null;
  socialLinks: string[];
  photoId: string | null;
  notes: string | null;
  metadata: Prisma.JsonValue;
  programmes?: Array<{ programmeId: string; paymentStatus: string }>;
};

type ProgrammeRecord = {
  id: string;
  name: string;
  startDate: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(value: Prisma.JsonValue): EventConfig {
  return isRecord(value) ? value : {};
}

function getRecipientIds(config: EventConfig) {
  return Array.isArray(config.recipientIds)
    ? config.recipientIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
}

function participantContext(participant: ParticipantRecord, programmeId: string) {
  const scopedProgramme = participant.programmes?.find((programme) => programme.programmeId === programmeId);
  const metadata = isRecord(participant.metadata) ? participant.metadata : {};

  return {
    id: participant.id,
    name: participant.name,
    email: participant.email,
    organisation: participant.organisation ?? "",
    organization: participant.organisation ?? "",
    address: participant.address ?? "",
    phone: participant.phone ?? "",
    socialLinks: participant.socialLinks,
    photoId: participant.photoId ?? "",
    notes: participant.notes ?? "",
    paymentStatus: scopedProgramme?.paymentStatus ?? "not_invoiced",
    metadata
  };
}

function programmeContext(programme: ProgrammeRecord) {
  return {
    id: programme.id,
    name: programme.name,
    startDate: programme.startDate.toISOString()
  };
}

export async function sendEmailEvent(input: {
  event: { id: string; programmeId: string; config: Prisma.JsonValue };
  programme: ProgrammeRecord;
  participants: ParticipantRecord[];
}) {
  const config = parseConfig(input.event.config);
  const subjectTemplate = typeof config.subject === "string" ? config.subject : "";
  const bodyTemplate = typeof config.body === "string" ? config.body : "";
  const fromName = typeof config.fromName === "string" && config.fromName.trim() ? config.fromName.trim() : undefined;
  const recipientType = config.recipientType === "specific_participants" ? "specific_participants" : "all_participants";
  const recipientIds = new Set(getRecipientIds(config));
  const recipients =
    recipientType === "specific_participants"
      ? input.participants.filter((participant) => recipientIds.has(participant.id))
      : input.participants;

  if (!subjectTemplate.trim()) throw new Error("Email event subject is required.");
  if (!bodyTemplate.trim()) throw new Error("Email event body is required.");
  if (recipients.length === 0) throw new Error("Email event has no recipients.");

  const programme = programmeContext(input.programme);
  const results = [];

  for (const participant of recipients) {
    const context = {
      participant: participantContext(participant, input.event.programmeId),
      programme
    };

    await sendAppScriptEmail({
      to: participant.email,
      subject: renderEmailTemplate(subjectTemplate, context),
      body: renderEmailTemplate(bodyTemplate, context),
      fromName
    });

    results.push({ participantId: participant.id, email: participant.email });
  }

  return {
    ok: true,
    sent: results.length,
    recipients: results
  };
}
