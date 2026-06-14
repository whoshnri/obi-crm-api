import { HttpError } from "../http.js";

export type AppScriptEmailMessage = {
  to: string;
  toName?: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  attachmentIds?: string[];
};

export type AppScriptAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  contentBase64: string;
};

export type AppScriptEmailBatchPayload = {
  type: "email_batch";
  fromName?: string;
  replyTo?: string;
  attachments?: AppScriptAttachment[];
  messages: AppScriptEmailMessage[];
};

export type AppScriptEmailResult = {
  ok: boolean;
  error?: string;
  sent?: number;
  failed?: number;
  placeholder?: boolean;
};

const CAMPAIGN_APP_SCRIPT_URL =
  process.env.OBI_EMAIL_APP_SCRIPT_URL ?? process.env.NEXT_PUBLIC_APP_SCRIPT_URL;
const AUTH_APP_SCRIPT_URL = process.env.OBI_AUTH_EMAIL_APP_SCRIPT_URL;
const EMAIL_PLACEHOLDER_MODE = process.env.OBI_EMAIL_PLACEHOLDER_MODE === "true";

const MISSING_CAMPAIGN_URL_ERROR =
  "OBI_EMAIL_APP_SCRIPT_URL is not configured. Set it to your campaign Apps Script deployment URL before sending emails.";

export function getCampaignAppScriptUrl() {
  return CAMPAIGN_APP_SCRIPT_URL ?? null;
}

export function isEmailPlaceholderMode() {
  return EMAIL_PLACEHOLDER_MODE;
}

export function getAuthAppScriptUrl() {
  return AUTH_APP_SCRIPT_URL ?? null;
}

export async function sendAppScriptEmailBatch(payload: AppScriptEmailBatchPayload) {
  const recipients = payload.messages.map((message) => message.to).join(", ");
  console.log(
    `[email] preparing batch — ${payload.messages.length} message(s) to ${recipients}`,
  );

  const url = getCampaignAppScriptUrl();
  if (!url) {
    const preview = payload.messages[0];
    const subject = preview ? ` (“${preview.subject}”)` : "";
    if (!EMAIL_PLACEHOLDER_MODE) {
      throw new HttpError(MISSING_CAMPAIGN_URL_ERROR, 503);
    }
    console.log(`[email:batch:placeholder] — ${payload.messages.length} message(s)${subject} (no App Script URL)`);
    return { ok: true, sent: 0, failed: 0, placeholder: true as const };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify({
      type: "email_batch",
      resources: payload
    })
  });

  const result = (await response.json().catch(() => null)) as AppScriptEmailResult | null;

  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error || `Email App Script request failed with ${response.status}.`);
  }

  const resolved = result ?? { ok: true, sent: payload.messages.length, failed: 0 };
  console.log(`[email] sent — ${resolved.sent ?? 0} ok, ${resolved.failed ?? 0} failed`);
  return resolved;
}

// Legacy single-email path kept for auth/portal console logging flows.
export type AppScriptSingleEmailPayload = {
  to: string;
  subject: string;
  body: string;
  fromName?: string;
};

export async function sendAppScriptAuthEmail(payload: AppScriptSingleEmailPayload) {
  const url = getAuthAppScriptUrl();
  if (!url) {
    console.log(`[email] auth placeholder — to ${payload.to}, subject “${payload.subject}”`);
    return { ok: true };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify({
      type: "email",
      resources: payload
    })
  });

  const result = (await response.json().catch(() => null)) as AppScriptEmailResult | null;
  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error || `Auth email App Script request failed with ${response.status}.`);
  }

  return result ?? { ok: true };
}
