import type { Context } from "hono";
import { ZodError } from "zod";

export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

type ApiErrorLogEntry = {
  timestamp: string;
  method: string;
  path: string;
  status: number;
  errorName: string;
  message: string;
  code?: string;
  meta?: unknown;
  issues?: unknown;
  prisma?: {
    clientVersion?: string;
    model?: string;
    target?: unknown;
  };
};

function getErrorName(error: unknown) {
  return error instanceof Error ? error.name : typeof error;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unexpected API error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPrismaSummary(error: unknown) {
  if (!isRecord(error)) return {};
  const meta = isRecord(error.meta) ? error.meta : undefined;
  return {
    code: typeof error.code === "string" ? error.code : undefined,
    meta: error.meta,
    prisma: {
      clientVersion: typeof error.clientVersion === "string" ? error.clientVersion : undefined,
      model: typeof meta?.modelName === "string" ? meta.modelName : undefined,
      target: meta?.target
    }
  };
}

function getErrorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function getHttpStatus(error: unknown) {
  if (error instanceof HttpError) return error.status;
  const code = getErrorCode(error);
  if (code === "P2025") return 404;
  if (code === "P2002") return 409;
  if (code === "P2003") return 409;
  if (code === "EAI_AGAIN" || code === "ENOTFOUND" || code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED") return 503;
  return 500;
}

function getShortMessage(error: unknown) {
  const code = getErrorCode(error);
  if (code === "P2025") return "Requested record was not found";
  if (code === "P2002") return "Unique constraint failed";
  if (code === "P2003") return "Foreign key constraint failed";
  if (code === "EAI_AGAIN") return "Database DNS lookup failed";
  if (code === "ENOTFOUND") return "Database host could not be resolved";
  if (code === "ETIMEDOUT") return "Database request timed out";
  if (code === "ECONNRESET") return "Database connection was reset";
  if (code === "ECONNREFUSED") return "Database connection was refused";

  const message = getErrorMessage(error);
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return message;
  const importantLine =
    lines.find((line) => line.startsWith("Invalid `prisma.")) ??
    lines.find((line) => line.includes("Unique constraint failed")) ??
    lines.find((line) => line.includes("Foreign key constraint failed")) ??
    lines.find((line) => line.includes("Argument `")) ??
    lines.find((line) => line.includes("Unknown argument")) ??
    lines[0];

  return importantLine.length > 240 ? `${importantLine.slice(0, 237)}...` : importantLine;
}

function getZodIssues(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
    code: issue.code
  }));
}

export function logApiError(c: Context, status: number, error: unknown, issues?: unknown) {
  const prisma = getPrismaSummary(error);
  const entry: ApiErrorLogEntry = {
    timestamp: new Date().toISOString(),
    method: c.req.method,
    path: c.req.path,
    status,
    errorName: getErrorName(error),
    message: getShortMessage(error),
    code: prisma.code,
    meta: prisma.meta,
    issues,
    prisma: prisma.prisma
  };

  console.error("[api:error]", JSON.stringify(entry, (_key, value) => (value === undefined ? undefined : value)));
}

function getClientErrorMessage(error: unknown, status: number) {
  if (error instanceof HttpError) return error.message;
  if (status === 404) return "Not found";
  if (status === 409) return "Conflict";
  if (status === 503) return "Database unavailable";
  return "Unexpected API error";
}

export async function handleRoute<T>(c: Context, fn: () => Promise<T> | T) {
  try {
    const data = await fn();
    if (data instanceof Response) {
      return data;
    }
    return c.json(data);
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = getZodIssues(error);
      logApiError(c, 400, error, issues);
      return c.json({ error: "Invalid request", issues: error.issues }, 400);
    }

    const status = getHttpStatus(error) as 400 | 404 | 409 | 500 | 503;
    logApiError(c, status, error);
    return c.json({ error: getClientErrorMessage(error, status) }, status);
  }
}
