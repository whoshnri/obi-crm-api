export type EmailCtaStyle = "button" | "link";

export function renderEmailCtaHtml(label: string, url: string, style: EmailCtaStyle = "button") {
  const safeLabel = label || "Click here";
  const safeUrl = url || "#";
  if (style === "link") {
    return `<p style="margin:16px 0;"><a href="${safeUrl}" data-email-cta="true" data-style="link" style="color:#335CFF;text-decoration:underline;font-weight:600;">${safeLabel}</a></p>`;
  }
  return `<p style="margin:16px 0;"><a href="${safeUrl}" data-email-cta="true" data-style="button" style="display:inline-block;padding:12px 20px;background:#335CFF;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">${safeLabel}</a></p>`;
}

export function expandEmailButtonsInHtml(html: string) {
  if (!html.includes("data-email-button")) return html;

  return html.replace(/<div\b([^>]*data-email-button[^>]*)><\/div>/gi, (_match, rawAttributes) => {
    const label = decodeAttribute(rawAttributes.match(/data-label="([^"]*)"/i)?.[1] ?? "Click here");
    const url = decodeAttribute(rawAttributes.match(/data-url="([^"]*)"/i)?.[1] ?? "#");
    const style = (rawAttributes.match(/data-style="([^"]*)"/i)?.[1] as EmailCtaStyle) ?? "button";
    return renderEmailCtaHtml(label, url, style);
  });
}

function decodeAttribute(value: string) {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

export function bodyHasInlineEmailButtons(html: string) {
  return html.includes("data-email-button") || html.includes("data-email-cta");
}
