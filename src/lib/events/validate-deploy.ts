import { EventBaseType, type Event, type Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { filterEventRecipients } from "../email/render.js";
import {
  getVariableBindingsFromConfig,
  parseTemplateMetadata,
  validateVariableBindings,
} from "../email/template-variables.js";
import { getEventRecipients, getStringConfig, parseEventConfig } from "../../jobs/utils.js";
import { checkAttachmentReachability } from "../email/attachments.js";
import { invoiceAmountErrorMessage, resolveInvoiceAmount } from "../invoices/resolve-amount.js";

export type EventValidationIssue = {
  eventId: string;
  eventName: string;
  errors: string[];
  warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAttachmentInputs(metadata: unknown, config: Record<string, unknown>) {
  const templateAttachments = isRecord(metadata) && Array.isArray(metadata.attachments)
    ? metadata.attachments.filter(isRecord).map((item) => ({
        url: typeof item.url === "string" ? item.url : "",
        filename: typeof item.filename === "string" ? item.filename : "attachment"
      }))
    : [];

  const configAttachments = Array.isArray(config.attachments)
    ? config.attachments.filter(isRecord).map((item) => ({
        url: typeof item.url === "string" ? item.url : "",
        filename: typeof item.filename === "string" ? item.filename : "attachment"
      }))
    : [];

  return [...templateAttachments, ...configAttachments].filter((item) => item.url.trim());
}

export async function validateEmailEvent(event: Event, options?: { checkAttachments?: boolean }) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const config = parseEventConfig(event.config);
  const templateId = getStringConfig(config, "templateId");

  let template: { subject: string; body: string; metadata: Prisma.JsonValue } | null = null;
  if (templateId) {
    template = await prisma.emailTemplate.findUnique({
      where: { id: templateId },
      select: { subject: true, body: true, metadata: true }
    });
    if (!template) {
      errors.push(`Template "${templateId}" was not found.`);
    }
  } else {
    const inlineSubject = getStringConfig(config, "subject") ?? "";
    const inlineBody = getStringConfig(config, "body") ?? "";
    if (!inlineSubject.trim() && !inlineBody.trim()) {
      errors.push("Select an email template for this event.");
    }
  }

  const subject = template?.subject ?? getStringConfig(config, "subject") ?? "";
  const body = template?.body ?? getStringConfig(config, "body") ?? "";

  if (!subject.trim()) errors.push("Missing email subject.");
  if (!body.trim()) errors.push("Missing email body.");

  if (template) {
    const metadata = parseTemplateMetadata(template.metadata);
    const validation = validateVariableBindings(
      metadata.variables ?? [],
      getVariableBindingsFromConfig(config as Record<string, unknown>),
    );
    if (!validation.valid) {
      errors.push(
        `Map all template variables before deploy: ${validation.missing.map((key) => `{{${key}}}`).join(", ")}`,
      );
    }
  }

  const baseRecipients = await getEventRecipients(event);
  const recipients = filterEventRecipients(baseRecipients, config);
  if (recipients.length === 0) {
    if (baseRecipients.length === 0) {
      errors.push(
        event.cohortId
          ? "No participants enrolled in this cohort yet."
          : "No participants enrolled in this programme yet.",
      );
    } else {
      errors.push(
        "Recipient selection does not match any enrolled participants. Re-open the event, re-select recipients, and save the flow.",
      );
    }
  }

  if (config.hasForm === true && !getStringConfig(config, "formId")) {
    errors.push("Select a published form for this feedback email.");
  }

  if (options?.checkAttachments) {
    const attachmentInputs = getAttachmentInputs(template?.metadata, config);
    for (const attachment of attachmentInputs) {
      const reachable = await checkAttachmentReachability(attachment.url);
      if (!reachable.ok) {
        warnings.push(`Attachment "${attachment.filename}" may be unreachable (${reachable.error}).`);
      }
    }
  }

  return { errors, warnings };
}

export async function validateInvoiceEvent(event: Event) {
  const errors: string[] = [];
  const warnings: string[] = [];

  const programme = await prisma.programme.findUnique({
    where: { id: event.programmeId },
    select: { costPerParticipant: true },
  });

  if (resolveInvoiceAmount(programme ?? { costPerParticipant: null }) === null) {
    errors.push(invoiceAmountErrorMessage());
  }

  const recipients = await getEventRecipients(event);
  if (recipients.length === 0) {
    errors.push("No recipients found for invoice event.");
  }

  const missingStripe = recipients.filter(({ participant }) => !participant.stripeCustomerId).length;
  if (missingStripe > 0) {
    warnings.push(`${missingStripe} recipient(s) are missing Stripe customer IDs.`);
  }

  return { errors, warnings };
}

export async function validateEventsForDeploy(events: Event[], options?: { checkAttachments?: boolean }) {
  const results: EventValidationIssue[] = [];

  for (const event of events) {
    const validation =
      event.baseType === EventBaseType.send_email
        ? await validateEmailEvent(event, options)
        : await validateInvoiceEvent(event);

    if (validation.errors.length > 0 || validation.warnings.length > 0) {
      results.push({
        eventId: event.id,
        eventName: event.name,
        errors: validation.errors,
        warnings: validation.warnings
      });
    }
  }

  const blocking = results.filter((item) => item.errors.length > 0);
  return {
    ok: blocking.length === 0,
    issues: results,
    blocking
  };
}
