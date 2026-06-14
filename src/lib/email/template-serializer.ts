import type { EmailTemplate, Prisma } from "@prisma/client";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeEmailTemplate(template: EmailTemplate) {
  return {
    id: template.id,
    programmeId: template.programmeId ?? null,
    name: template.name,
    label: template.label ?? null,
    description: template.description ?? null,
    subject: template.subject,
    body: template.body,
    fromName: template.fromName ?? null,
    metadata: isRecord(template.metadata) ? template.metadata : {},
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString()
  };
}

export function emailTemplateCreateData(input: {
  programmeId?: string;
  name: string;
  label?: string;
  description?: string;
  subject: string;
  body: string;
  fromName?: string;
  metadata?: Record<string, unknown>;
}): Prisma.EmailTemplateCreateInput {
  return {
    ...(input.programmeId ? { programme: { connect: { id: input.programmeId } } } : {}),
    name: input.name,
    label: input.label ?? null,
    description: input.description ?? null,
    subject: input.subject,
    body: input.body,
    fromName: input.fromName ?? null,
    metadata: (input.metadata ?? {}) as Prisma.InputJsonValue
  };
}

export function emailTemplateUpdateData(input: {
  name?: string;
  label?: string | null;
  description?: string | null;
  subject?: string;
  body?: string;
  fromName?: string | null;
  metadata?: Record<string, unknown>;
}): Prisma.EmailTemplateUpdateInput {
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.fromName !== undefined ? { fromName: input.fromName } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {})
  };
}
