import type { Event } from "@prisma/client";
import { prisma } from "../prisma.js";
import { getStringConfig, parseEventConfig } from "../../jobs/utils.js";

export function getFormsAppOrigin() {
  return process.env.OBI_FORMS_APP_ORIGIN ?? process.env.NEXT_PUBLIC_OBI_FORMS_APP_URL ?? "http://localhost:3000";
}

export function buildPublicFormUrl(slug: string) {
  return `${getFormsAppOrigin().replace(/\/$/, "")}/${slug}`;
}

export function buildParticipantFormUrl(formUrl: string, email: string) {
  const url = new URL(formUrl);
  url.searchParams.set("email", email);
  return url.toString();
}

export async function resolveEventFormUrl(event: Pick<Event, "programmeId" | "config">) {
  const config = parseEventConfig(event.config);
  const formId = getStringConfig(config, "formId");
  if (!formId) return null;

  const form = await prisma.form.findFirst({
    where: {
      id: formId,
      programmeId: event.programmeId,
    },
    select: { slug: true, status: true, name: true },
  });

  if (!form) {
    throw new Error("The linked form was not found for this programme.");
  }

  if (form.status !== "published") {
    throw new Error(`Publish "${form.name}" on the Forms page before sending this email.`);
  }

  return buildPublicFormUrl(form.slug);
}

export function appendFormButton(bodyHtml: string, formUrl: string, label = "Open form") {
  return `${bodyHtml}<p style="margin:16px 0;"><a href="${formUrl}" style="display:inline-block;padding:10px 16px;background:#335CFF;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">${label}</a></p>`;
}
