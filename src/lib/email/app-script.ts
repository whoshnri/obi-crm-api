export type AppScriptEmailPayload = {
  to: string;
  subject: string;
  body: string;
  fromName?: string;
};

export type AppScriptEmailResult = {
  ok: boolean;
  error?: string;
};

const EMAIL_APP_SCRIPT_URL = process.env.OBI_EMAIL_APP_SCRIPT_URL ?? process.env.NEXT_PUBLIC_APP_SCRIPT_URL;

export async function sendAppScriptEmail(payload: AppScriptEmailPayload) {
  if (!EMAIL_APP_SCRIPT_URL) {
    throw new Error("Missing OBI_EMAIL_APP_SCRIPT_URL.");
  }

  const response = await fetch(EMAIL_APP_SCRIPT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify({
      type: "email",
      resources: payload
    })
  });

  const result = await response.json().catch(() => null) as AppScriptEmailResult | null;

  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error || `Email App Script request failed with ${response.status}.`);
  }

  return result ?? { ok: true };
}
