import type { EmailTemplate, Event, Participant, Programme } from "@prisma/client";
import { prisma } from "../prisma.js";
import { prepareAttachments } from "./attachments.js";
import { bodyHasInlineEmailButtons, expandEmailButtonsInHtml } from "./email-cta.js";
import { sendAppScriptEmailBatch, type AppScriptEmailMessage } from "./app-script.js";
import { appendFormButton, buildParticipantFormUrl, resolveEventFormUrl } from "./form-links.js";
import {
  filterEventRecipients,
  normalizeTemplateVariables,
  participantToContext,
  renderEmailTemplate,
  renderTemplateWithBindings,
  type EmailRenderContext
} from "./render.js";
import {
  getVariableBindingsFromConfig,
  parseTemplateMetadata,
  validateVariableBindings,
  type TemplateButtonDefinition,
  type TemplateMetadata,
} from "./template-variables.js";
import { getEventRecipients, getStringConfig, parseEventConfig } from "../../jobs/utils.js";

function htmlToPlainText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function finalizeBodyHtml(
  bodyHtml: string,
  buttons: TemplateMetadata["buttons"],
  context: EmailRenderContext,
) {
  let html = expandEmailButtonsInHtml(bodyHtml);
  if (!bodyHasInlineEmailButtons(bodyHtml) && buttons?.length) {
    html = appendButtons(html, buttons, context);
  }
  return html;
}

function appendButtons(bodyHtml: string, buttons: TemplateMetadata["buttons"], context: EmailRenderContext) {
  if (!buttons?.length) return bodyHtml;

  const renderedButtons = buttons
    .map((button) => {
      const label = renderEmailTemplate(normalizeTemplateVariables(button.label), context);
      const url = renderEmailTemplate(normalizeTemplateVariables(button.url), context);
      if (button.style === "link") {
        return `<p style="margin:16px 0;"><a href="${url}" data-email-cta="true" data-style="link" style="color:#335CFF;text-decoration:underline;font-weight:600;">${label}</a></p>`;
      }
      return `<p style="margin:16px 0;"><a href="${url}" data-email-cta="true" data-style="button" style="display:inline-block;padding:12px 20px;background:#335CFF;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">${label}</a></p>`;
    })
    .join("");

  return `${bodyHtml}${renderedButtons}`;
}

export async function resolveEmailContent(input: {
  event: Pick<Event, "config">;
  template: EmailTemplate | null;
}) {
  const config = parseEventConfig(input.event.config);
  const template = input.template;

  const subject = template?.subject ?? getStringConfig(config, "subject") ?? "";
  const body = template?.body ?? getStringConfig(config, "body") ?? "";
  const fromName = getStringConfig(config, "fromName") ?? template?.fromName ?? undefined;

  if (!subject.trim() || !body.trim()) {
    throw new Error("Email content is missing subject and body.");
  }

  const metadata = parseTemplateMetadata(template?.metadata);
  const bindings = getVariableBindingsFromConfig(config as Record<string, unknown>);
  const configAttachments = Array.isArray(config.attachments)
    ? config.attachments
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
        .map((item) => ({
          url: typeof item.url === "string" ? item.url : "",
          filename: typeof item.filename === "string" ? item.filename : "attachment",
          mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined
        }))
    : [];

  const attachmentInputs = [...(metadata.attachments ?? []), ...configAttachments];

  if (template && (metadata.variables?.length ?? 0) > 0) {
    const validation = validateVariableBindings(metadata.variables ?? [], bindings);
    if (!validation.valid) {
      throw new Error(`Missing variable bindings: ${validation.missing.join(", ")}`);
    }
  }

  return {
    subject,
    body,
    fromName,
    bindings,
    buttons: metadata.buttons ?? [],
    attachmentInputs
  };
}

export async function buildProgrammeEmailMessages(input: {
  event: Event & { programme: Programme };
  template: EmailTemplate | null;
  sampleParticipant?: Participant | null;
}) {
  const { event, template } = input;
  const content = await resolveEmailContent({ event, template });
  const config = parseEventConfig(event.config);
  const formUrl = await resolveEventFormUrl(event);

  const recipients = input.sampleParticipant
    ? [{ participant: input.sampleParticipant, programmeParticipant: null }]
    : filterEventRecipients(await getEventRecipients(event), config);

  if (recipients.length === 0) {
    throw new Error("No recipients found for this event.");
  }

  const attachments = await prepareAttachments(content.attachmentInputs);
  const attachmentIds = attachments.map((attachment) => attachment.id);

  const messages: AppScriptEmailMessage[] = recipients.map(({ participant }) => {
    const context: EmailRenderContext = {
      participant: participantToContext(participant),
      programme: {
        id: event.programme.id,
        name: event.programme.name
      },
      event: {
        id: event.id,
        name: event.name,
        ...(formUrl ? { formUrl } : {})
      }
    };

    const subject = renderTemplateWithBindings(content.subject, content.bindings, context);
    let bodyHtml = finalizeBodyHtml(
      renderTemplateWithBindings(content.body, content.bindings, context),
      content.buttons,
      context,
    );
    if (formUrl) {
      const participantFormUrl = buildParticipantFormUrl(formUrl, participant.email);
      bodyHtml = appendFormButton(bodyHtml, participantFormUrl, "Open form");
    }

    return {
      to: participant.email,
      toName: participant.name,
      subject,
      bodyHtml,
      bodyText: htmlToPlainText(bodyHtml),
      attachmentIds: attachmentIds.length ? attachmentIds : undefined
    };
  });

  return {
    content,
    recipients,
    attachments,
    messages
  };
}

export async function buildAndSendProgrammeEmailBatch(input: {
  event: Event & { programme: Programme };
  template: EmailTemplate | null;
}) {
  const built = await buildProgrammeEmailMessages(input);

  await sendAppScriptEmailBatch({
    type: "email_batch",
    fromName: built.content.fromName,
    attachments: built.attachments.length ? built.attachments : undefined,
    messages: built.messages
  });

  return {
    recipients: built.recipients,
    messages: built.messages
  };
}

export async function buildAndSendOpportunityEmailBatch(input: {
  to: string;
  toName?: string;
  fromName?: string;
  subject: string;
  bodyHtml: string;
  attachments?: TemplateMetadata["attachments"];
  buttons?: TemplateButtonDefinition[];
  context?: EmailRenderContext;
}) {
  const attachments = await prepareAttachments(input.attachments ?? []);
  const attachmentIds = attachments.map((attachment) => attachment.id);
  const bodyHtml =
    input.context
      ? finalizeBodyHtml(input.bodyHtml, input.buttons, input.context)
      : expandEmailButtonsInHtml(input.bodyHtml);
  const message: AppScriptEmailMessage = {
    to: input.to,
    toName: input.toName,
    subject: input.subject,
    bodyHtml,
    bodyText: htmlToPlainText(bodyHtml),
    attachmentIds: attachmentIds.length ? attachmentIds : undefined
  };

  await sendAppScriptEmailBatch({
    type: "email_batch",
    fromName: input.fromName,
    attachments: attachments.length ? attachments : undefined,
    messages: [message]
  });

  return { messages: [message] };
}

export async function loadEmailTemplateForEvent(event: Pick<Event, "programmeId" | "config">) {
  const config = parseEventConfig(event.config);
  const templateId = getStringConfig(config, "templateId");
  if (!templateId) return null;

  const template = await prisma.emailTemplate.findUnique({
    where: { id: templateId }
  });

  if (!template) {
    throw new Error(`Email template ${templateId} was not found.`);
  }

  return template;
}

export async function sendTemplateTestEmail(input: {
  template: EmailTemplate;
  to: string;
  toName?: string;
  sampleContext?: EmailRenderContext;
}) {
  const metadata = parseTemplateMetadata(input.template.metadata);
  const context =
    input.sampleContext ??
    ({
      participant: {
        name: "Alex Example",
        email: input.to,
        organisation: "Example Org"
      },
      programme: {
        name: "Sample Programme"
      }
    } as EmailRenderContext);

  const subject = renderEmailTemplate(normalizeTemplateVariables(input.template.subject), context);
  const bodyHtml = finalizeBodyHtml(
    renderEmailTemplate(normalizeTemplateVariables(input.template.body), context),
    metadata.buttons,
    context,
  );

  const attachments = await prepareAttachments(metadata.attachments ?? []);

  await sendAppScriptEmailBatch({
    type: "email_batch",
    fromName: input.template.fromName ?? undefined,
    attachments: attachments.length ? attachments : undefined,
    messages: [
      {
        to: input.to,
        toName: input.toName ?? "Test Recipient",
        subject: `[TEST] ${subject}`,
        bodyHtml,
        bodyText: htmlToPlainText(bodyHtml),
        attachmentIds: attachments.length ? attachments.map((item) => item.id) : undefined
      }
    ]
  });
}

export async function sendEventTestEmail(input: {
  event: Event & { programme: Programme };
  template: EmailTemplate | null;
  to: string;
  toName?: string;
}) {
  const sampleParticipant = {
    id: "test-participant",
    name: input.toName ?? "Test Recipient",
    email: input.to,
    organisation: "Example Org",
    address: null,
    phone: null,
    notes: null,
    metadata: {},
    password: null,
    socialLinks: [],
    photoId: null,
    stripeCustomerId: null,
    createdAt: new Date(),
    updatedAt: new Date()
  } as Participant;

  const built = await buildProgrammeEmailMessages({
    event: input.event,
    template: input.template,
    sampleParticipant
  });

  const message = {
    ...built.messages[0],
    subject: `[TEST] ${built.messages[0].subject}`
  };

  await sendAppScriptEmailBatch({
    type: "email_batch",
    fromName: built.content.fromName,
    attachments: built.attachments.length ? built.attachments : undefined,
    messages: [message]
  });
}
