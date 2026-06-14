import path from "node:path";

export type PreparedAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  contentBase64: string;
};

type AttachmentInput = {
  url: string;
  filename: string;
  mimeType?: string;
};

export const MAX_ATTACHMENT_BYTES = Number(process.env.OBI_EMAIL_MAX_ATTACHMENT_BYTES ?? 8 * 1024 * 1024);
export const MAX_BATCH_ATTACHMENT_BYTES = Number(process.env.OBI_EMAIL_MAX_BATCH_ATTACHMENT_BYTES ?? 20 * 1024 * 1024);

function guessMimeType(filename: string, contentType: string | null) {
  if (contentType && contentType !== "application/octet-stream") return contentType;

  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}

export async function checkAttachmentReachability(url: string) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) {
      return { ok: false as const, error: `HTTP ${response.status}` };
    }
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "unreachable"
    };
  }
}

export async function downloadAttachment(input: AttachmentInput, index: number): Promise<PreparedAttachment> {
  const response = await fetch(input.url);
  if (!response.ok) {
    throw new Error(`Failed to download attachment "${input.filename}" (${response.status})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment "${input.filename}" exceeds the ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB limit.`
    );
  }

  const mimeType = guessMimeType(input.filename, response.headers.get("content-type"));

  return {
    id: `att-${index + 1}`,
    filename: input.filename,
    mimeType,
    contentBase64: buffer.toString("base64")
  };
}

export async function prepareAttachments(inputs: AttachmentInput[]) {
  const valid = inputs.filter((item) => item.url.trim() && item.filename.trim());
  const prepared: PreparedAttachment[] = [];
  let totalBytes = 0;

  for (const [index, item] of valid.entries()) {
    const attachment = await downloadAttachment(item, index);
    const bytes = Buffer.byteLength(attachment.contentBase64, "base64");
    totalBytes += bytes;

    if (totalBytes > MAX_BATCH_ATTACHMENT_BYTES) {
      throw new Error(
        `Combined attachment size exceeds the ${Math.round(MAX_BATCH_ATTACHMENT_BYTES / (1024 * 1024))}MB batch limit.`
      );
    }

    prepared.push(attachment);
  }

  return prepared;
}
