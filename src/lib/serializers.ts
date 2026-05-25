import type { Participant, ParticipantInvoice, Prisma, Programme, ProgrammeParticipant } from "../generated/client.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeEvent(event: {
  id: string;
  name: string;
  programmeId: string;
  baseType: string;
  status: string;
  scheduledAt: Date;
  createdAt: Date;
  config: Prisma.JsonValue;
  eventFlowId?: string | null;
}) {
  return {
    id: event.id,
    name: event.name,
    programmeId: event.programmeId,
    baseType: event.baseType,
    status: event.status,
    scheduledAt: event.scheduledAt.toISOString(),
    createdAt: event.createdAt.toISOString(),
    config: isRecord(event.config) ? event.config : {},
    eventFlowId: event.eventFlowId ?? undefined
  };
}

export function serializeBaseParticipant(participant: Participant) {
  return {
    id: participant.id,
    name: participant.name,
    email: participant.email,
    organisation: participant.organisation ?? undefined,
    address: participant.address ?? undefined,
    phone: participant.phone ?? undefined,
    socialLinks: participant.socialLinks,
    photoId: participant.photoId ?? undefined,
    stripeCustomerId: participant.stripeCustomerId ?? undefined,
    createdAt: participant.createdAt.toISOString(),
    updatedAt: participant.updatedAt.toISOString(),
    notes: participant.notes ?? undefined,
    metadata: isRecord(participant.metadata) ? participant.metadata : {}
  };
}

export function serializeProgramParticipant(programParticipant: ProgrammeParticipant & {
  participant: Participant;
  programme: Programme;
  invoice?: ParticipantInvoice | null;
}) {
  const baseParticipant = serializeBaseParticipant(programParticipant.participant);

  return {
    ...baseParticipant,
    id: programParticipant.id,
    participantId: programParticipant.participantId,
    programmeId: programParticipant.programmeId,
    programmeIds: [programParticipant.programmeId],
    paymentStatus: programParticipant.paymentStatus,
    invoiceId: programParticipant.invoiceId ?? undefined,
    enrolledAt: programParticipant.createdAt.toISOString(),
    createdAt: programParticipant.createdAt.toISOString(),
    updatedAt: programParticipant.updatedAt.toISOString(),
    metadata: isRecord(programParticipant.metadata) ? programParticipant.metadata : {},
    participant: baseParticipant,
    programme: serializeProgramme(programParticipant.programme),
    invoice: programParticipant.invoice ? serializeInvoice(programParticipant.invoice) : undefined
  };
}

export function serializeInvoice(invoice: {
  id: string;
  programmeId: string;
  participantId: string;
  amount: number;
  currency: string;
  status: string;
  dueDate: Date;
  paidAt: Date | null;
  stripeInvoiceId: string | null;
  stripeInvoiceUrl?: string | null;
  stripeInvoiceItemIds?: string[];
  lineItems?: Prisma.JsonValue;
  metadata?: Prisma.JsonValue;
}) {
  return {
    id: invoice.id,
    programmeId: invoice.programmeId,
    participantId: invoice.participantId,
    participantIds: [invoice.participantId],
    amount: invoice.amount,
    currency: invoice.currency,
    status: invoice.status,
    dueDate: invoice.dueDate.toISOString(),
    paidAt: invoice.paidAt?.toISOString(),
    stripeInvoiceId: invoice.stripeInvoiceId ?? undefined,
    stripeInvoiceUrl: invoice.stripeInvoiceUrl ?? undefined,
    stripeInvoiceItemIds: invoice.stripeInvoiceItemIds ?? [],
    lineItems: Array.isArray(invoice.lineItems) ? invoice.lineItems : [],
    metadata: isRecord(invoice.metadata) ? invoice.metadata : {}
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
  description: string | null;
  costPerParticipant: number | null;
  startDate: Date;
  participantDefinition: Prisma.JsonValue;
  eventFlow?: {
    flow: Prisma.JsonValue;
    deployedAt: Date | null;
  } | null;
  participants?: Array<{ participantId: string }>;
  events?: Array<Parameters<typeof serializeEvent>[0]>;
}) {
  return {
    id: programme.id,
    name: programme.name,
    description: programme.description ?? undefined,
    costPerParticipant: programme.costPerParticipant ?? undefined,
    startDate: programme.startDate.toISOString(),
    eventFlow: isRecord(programme.eventFlow?.flow) ? programme.eventFlow.flow : {},
    eventFlowDeployedAt: programme.eventFlow?.deployedAt?.toISOString() ?? null,
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
