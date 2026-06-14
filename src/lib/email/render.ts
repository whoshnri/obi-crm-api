import type { Event, Participant, ProgrammeParticipant } from "@prisma/client";
import { parseEventConfig, getStringConfig } from "../../jobs/utils.js";

export type EmailRenderContext = {
  participant: Record<string, unknown>;
  programme?: Record<string, unknown>;
  event?: Record<string, unknown>;
};

export function participantToContext(participant: Participant) {
  return {
    name: participant.name,
    email: participant.email,
    organisation: participant.organisation ?? "",
    phone: participant.phone ?? "",
    address: participant.address ?? "",
    notes: participant.notes ?? "",
    ...(typeof participant.metadata === "object" && participant.metadata && !Array.isArray(participant.metadata)
      ? participant.metadata
      : {})
  };
}

function getPathValue(context: EmailRenderContext, path: string) {
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "";

  const rootKey = parts[0];
  const root =
    rootKey === "participant"
      ? context.participant
      : rootKey === "programme"
        ? context.programme
        : rootKey === "event"
          ? context.event
          : context.participant;

  if (parts.length === 1) {
    return root?.[rootKey] ?? root;
  }

  return parts.slice(1).reduce<unknown>((value, key) => {
    if (value && typeof value === "object" && key in (value as Record<string, unknown>)) {
      return (value as Record<string, unknown>)[key];
    }
    return "";
  }, root);
}

function stringifyVariable(value: unknown) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function renderEmailTemplate(template: string, context: EmailRenderContext) {
  return template.replace(/\$\{\s*([^}]+?)\s*\}/g, (_match, path) =>
    stringifyVariable(getPathValue(context, String(path)))
  );
}

export function normalizeTemplateVariables(template: string) {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, variable) => `\${${String(variable).trim()}}`);
}

export function applyVariableBindings(
  template: string,
  bindings: Record<string, string>,
  context: EmailRenderContext,
) {
  const normalized = normalizeTemplateVariables(template);
  return Object.entries(bindings).reduce((result, [variableKey, scopePath]) => {
    const value = getPathValue(context, scopePath);
    const escaped = variableKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return result.replace(new RegExp(`\\$\\{\\s*${escaped}\\s*\\}`, "g"), stringifyVariable(value));
  }, normalized);
}

export function renderTemplateWithBindings(
  template: string,
  bindings: Record<string, string> | undefined,
  context: EmailRenderContext,
) {
  const bound = bindings ? applyVariableBindings(template, bindings, context) : normalizeTemplateVariables(template);
  return renderEmailTemplate(bound, context);
}

export function filterEventRecipients(
  recipients: Array<{ participant: Participant; programmeParticipant: ProgrammeParticipant | null }>,
  config: ReturnType<typeof parseEventConfig>
) {
  const recipientType = getStringConfig(config, "recipientType") ?? "all_participants";
  if (recipientType !== "specific_participants") return recipients;

  const recipientIds = Array.isArray(config.recipientIds)
    ? config.recipientIds.filter((id): id is string => typeof id === "string")
    : [];

  if (recipientIds.length === 0) return [];

  const allowed = new Set(recipientIds);
  return recipients.filter(
    ({ participant, programmeParticipant }) =>
      allowed.has(participant.id) ||
      (programmeParticipant ? allowed.has(programmeParticipant.id) : false),
  );
}
