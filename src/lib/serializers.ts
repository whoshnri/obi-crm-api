import type { Prisma } from "../generated/client";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeEvent(event: {
  id: string;
  name: string;
  programmeId: string;
  baseType: string;
  instanceType: string;
  status: string;
  scheduledAt: Date;
  createdAt: Date;
  config: Prisma.JsonValue;
}) {
  return {
    id: event.id,
    name: event.name,
    programmeId: event.programmeId,
    baseType: event.baseType,
    instanceType: event.instanceType,
    status: event.status,
    scheduledAt: event.scheduledAt.toISOString(),
    createdAt: event.createdAt.toISOString(),
    config: isRecord(event.config) ? event.config : {}
  };
}

export function serializeParticipant(participant: {
  id: string;
  name: string;
  email: string;
  organisation: string | null;
  address: string | null;
  phone: string | null;
  socialLinks: string[];
  photoId: string | null;
  stripeCustomerId: string | null;
  stripeInvoiceIds: string[];
  createdAt: Date;
  updatedAt: Date;
  notes: string | null;
  metadata: Prisma.JsonValue;
  programmes?: Array<{ programmeId: string; paymentStatus: string }>;
}, scopedProgrammeId?: string) {
  const scopedProgramme = scopedProgrammeId
    ? participant.programmes?.find((programme) => programme.programmeId === scopedProgrammeId)
    : participant.programmes?.[0];

  return {
    id: participant.id,
    programmeId: scopedProgramme?.programmeId,
    programmeIds: participant.programmes?.map((programme) => programme.programmeId) ?? [],
    name: participant.name,
    email: participant.email,
    organisation: participant.organisation ?? undefined,
    address: participant.address ?? undefined,
    phone: participant.phone ?? undefined,
    socialLinks: participant.socialLinks,
    photoId: participant.photoId ?? undefined,
    paymentStatus: scopedProgramme?.paymentStatus ?? "not_invoiced",
    stripeCustomerId: participant.stripeCustomerId ?? undefined,
    stripeInvoiceIds: participant.stripeInvoiceIds,
    createdAt: participant.createdAt.toISOString(),
    updatedAt: participant.updatedAt.toISOString(),
    notes: participant.notes ?? undefined,
    metadata: isRecord(participant.metadata) ? participant.metadata : {}
  };
}

export function serializeInvoice(invoice: {
  id: string;
  programmeId: string;
  amount: number;
  currency: string;
  status: string;
  dueDate: Date;
  paidAt: Date | null;
  stripeInvoiceUrl: string | null;
  participants?: Array<{ participantId: string; invoiceTotal: number }>;
}) {
  const participantIds = invoice.participants?.map((participant) => participant.participantId) ?? [];

  return {
    id: invoice.id,
    programmeId: invoice.programmeId,
    participantId: participantIds[0],
    participantIds,
    amount: invoice.amount,
    currency: invoice.currency,
    status: invoice.status,
    dueDate: invoice.dueDate.toISOString(),
    paidAt: invoice.paidAt?.toISOString(),
    stripeInvoiceUrl: invoice.stripeInvoiceUrl ?? undefined
  };
}

export function serializeFormTable(formTable: {
  id: string;
  programmeId: string;
  eventId: string;
  name: string;
  formSchema: Prisma.JsonValue;
  entries: Prisma.JsonValue;
}) {
  return {
    id: formTable.id,
    programmeId: formTable.programmeId,
    eventId: formTable.eventId,
    name: formTable.name,
    formSchema: Array.isArray(formTable.formSchema) ? formTable.formSchema : [],
    entries: Array.isArray(formTable.entries) ? formTable.entries : []
  };
}

export function serializeProgramme(programme: {
  id: string;
  name: string;
  startDate: Date;
  participantDefinition: Prisma.JsonValue;
  eventFlow?: Prisma.JsonValue;
  participants?: Array<{ participantId: string }>;
  events?: Array<Parameters<typeof serializeEvent>[0]>;
}) {
  return {
    id: programme.id,
    name: programme.name,
    startDate: programme.startDate.toISOString(),
    eventFlow: isRecord(programme.eventFlow) ? programme.eventFlow : {},
    participantDefinition: isRecord(programme.participantDefinition) ? programme.participantDefinition : { fields: [] },
    participants: programme.participants?.map((participant) => participant.participantId) ?? [],
    events: programme.events?.map(serializeEvent) ?? []
  };
}

export function serializeAdmin(admin: {
  id: string;
  name: string;
  email: string;
  role: string;
  notificationsEnabled: boolean;
  photoId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    notificationsEnabled: admin.notificationsEnabled,
    photoId: admin.photoId ?? undefined,
    createdAt: admin.createdAt.toISOString(),
    updatedAt: admin.updatedAt.toISOString()
  };
}

export function serializeForm(form: {
  id: string;
  programmeId: string | null;
  eventId: string | null;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  sections: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: form.id,
    programmeId: form.programmeId ?? undefined,
    eventId: form.eventId ?? undefined,
    slug: form.slug,
    name: form.name,
    description: form.description ?? undefined,
    status: form.status,
    sections: Array.isArray(form.sections) ? form.sections : [],
    createdAt: form.createdAt.toISOString(),
    updatedAt: form.updatedAt.toISOString()
  };
}

export function serializeFormSubmission(submission: {
  id: string;
  formId: string;
  respondentId: string | null;
  answers: Prisma.JsonValue;
  metadata: Prisma.JsonValue;
  createdAt: Date;
}) {
  return {
    id: submission.id,
    formId: submission.formId,
    respondentId: submission.respondentId ?? undefined,
    answers: isRecord(submission.answers) ? submission.answers : {},
    metadata: isRecord(submission.metadata) ? submission.metadata : {},
    createdAt: submission.createdAt.toISOString()
  };
}
