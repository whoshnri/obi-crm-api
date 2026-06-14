import type {
  Cohort,
  CohortProgramme,
  Organisation,
  Participant,
  ParticipantInvoice,
  Prisma,
  Programme,
  ProgrammeParticipant,
  RegistrationPage
} from "@prisma/client";

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
  cohortEventFlowId?: string | null;
  cohortId?: string | null;
  executionMetadata?: Prisma.JsonValue;
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
    executionMetadata: isRecord(event.executionMetadata) ? event.executionMetadata : undefined,
    eventFlowId: event.eventFlowId ?? undefined,
    cohortEventFlowId: event.cohortEventFlowId ?? undefined,
    cohortId: event.cohortId ?? undefined
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

type ParticipantOrganisationLink = {
  isPrimary: boolean;
  organisation: Organisation;
};

export function resolveLinkedOrganisation(
  participant: Participant & { organisations?: ParticipantOrganisationLink[] },
  cohort?: { organisation?: Organisation | null } | null,
) {
  const links = participant.organisations ?? [];
  const primary = links.find((link) => link.isPrimary) ?? links[0];
  if (primary?.organisation) {
    return serializeOrganisationSummary(primary.organisation);
  }
  if (cohort?.organisation) {
    return serializeOrganisationSummary(cohort.organisation);
  }
  return undefined;
}

export function serializeParticipantEnrollmentSummary(
  enrollment: ProgrammeParticipant & { programme: Programme },
) {
  return {
    id: enrollment.id,
    programmeId: enrollment.programmeId,
    paymentStatus: enrollment.paymentStatus,
    enrolledAt: enrollment.createdAt.toISOString(),
    programme: {
      id: enrollment.programme.id,
      name: enrollment.programme.name,
      startDate: enrollment.programme.startDate.toISOString(),
    },
  };
}

export function serializeParticipantDirectory(
  participant: Participant & {
    organisations?: ParticipantOrganisationLink[];
    programmes?: Array<ProgrammeParticipant & { programme: Programme }>;
  },
) {
  const enrollments = participant.programmes ?? [];

  return {
    ...serializeBaseParticipant(participant),
    linkedOrganisation: resolveLinkedOrganisation(participant),
    programmeIds: enrollments.map((enrollment) => enrollment.programmeId),
    enrollments: enrollments.map(serializeParticipantEnrollmentSummary),
  };
}

export function serializeProgramParticipant(programParticipant: ProgrammeParticipant & {
  participant: Participant & { organisations?: ParticipantOrganisationLink[] };
  programme: Programme;
  cohort?: { organisation?: Organisation | null } | null;
  invoice?: ParticipantInvoice | null;
  progress?: Array<{ completionPct: number; programmeId?: string }>;
}) {
  const baseParticipant = serializeBaseParticipant(programParticipant.participant);
  const progressRecord = programParticipant.progress?.[0];
  const linkedOrganisation = resolveLinkedOrganisation(
    programParticipant.participant,
    programParticipant.cohort,
  );

  return {
    ...baseParticipant,
    id: programParticipant.id,
    participantId: programParticipant.participantId,
    programmeId: programParticipant.programmeId,
    cohortId: programParticipant.cohortId ?? undefined,
    programmeIds: [programParticipant.programmeId],
    paymentStatus: programParticipant.paymentStatus,
    invoiceId: programParticipant.invoiceId ?? undefined,
    enrolledAt: programParticipant.createdAt.toISOString(),
    createdAt: programParticipant.createdAt.toISOString(),
    updatedAt: programParticipant.updatedAt.toISOString(),
    completionPct: progressRecord?.completionPct,
    progressPct: progressRecord?.completionPct,
    metadata: isRecord(programParticipant.metadata) ? programParticipant.metadata : {},
    linkedOrganisation,
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
  metadata: Prisma.JsonValue;
  registrationResourceId?: string | null;
  eventFlow?: {
    id?: string;
    flow: Prisma.JsonValue;
    deployedAt: Date | null;
    events?: Array<Parameters<typeof serializeEvent>[0]>;
  } | null;
  participants?: Array<{ participantId: string }>;
}) {
  const flowEvents = programme.eventFlow?.events ?? [];
  return {
    id: programme.id,
    name: programme.name,
    description: programme.description ?? undefined,
    costPerParticipant: programme.costPerParticipant ?? undefined,
    startDate: programme.startDate.toISOString(),
    registrationResourceId: programme.registrationResourceId ?? undefined,
    eventFlow: {
      id: programme.eventFlow?.id,
      flow: isRecord(programme.eventFlow?.flow) ? programme.eventFlow.flow : {},
      deployedAt: programme.eventFlow?.deployedAt?.toISOString() ?? null,
      events: flowEvents.map(serializeEvent)
    },
    eventFlowDeployedAt: programme.eventFlow?.deployedAt?.toISOString() ?? null,
    metadata: isRecord(programme.metadata) ? programme.metadata : {},
    participants: programme.participants?.map((participant) => participant.participantId) ?? []
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
  _count?: { submissions: number };
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
    submissionsCount: form._count?.submissions ?? 0,
    createdAt: form.createdAt.toISOString(),
    updatedAt: form.updatedAt.toISOString()
  };
}

export function serializeOrganisationSummary(organisation: Organisation) {
  return {
    id: organisation.id,
    name: organisation.name,
    slug: organisation.slug,
    logoUrl: organisation.logoUrl ?? undefined,
    website: organisation.website ?? undefined,
    size: organisation.size ?? undefined,
    industry: organisation.industry ?? undefined,
    address: organisation.address ?? undefined,
    contactName: organisation.contactName ?? undefined,
    contactEmail: organisation.contactEmail ?? undefined,
    contactPhone: organisation.contactPhone ?? undefined,
    parentOrganisationId: organisation.parentOrganisationId ?? undefined,
    metadata: isRecord(organisation.metadata) ? organisation.metadata : {},
    createdAt: organisation.createdAt.toISOString(),
    updatedAt: organisation.updatedAt.toISOString()
  };
}

export function serializeOrganisation(
  organisation: Organisation & {
    _count?: { cohorts: number; participants: number };
    cohorts?: Cohort[];
  }
) {
  return {
    ...serializeOrganisationSummary(organisation),
    _count: organisation._count,
    cohorts: organisation.cohorts?.map((cohort) => serializeCohort(cohort)) ?? undefined
  };
}

export function serializeCohort(
  cohort: Cohort & {
    _count?: { participants: number; programmes: number; registrationPages: number };
    programmes?: Array<CohortProgramme & { programme?: Programme }>;
    participants?: Array<{ id: string; participantId: string; joinedAt: Date; participant?: Participant }>;
    registrationPages?: RegistrationPage[];
    eventFlows?: Array<{
      id: string;
      flow: Prisma.JsonValue;
      deployedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
      events?: Array<Parameters<typeof serializeEvent>[0]>;
    }>;
    organisation?: Organisation | null;
  }
) {
  return {
    id: cohort.id,
    name: cohort.name,
    slug: cohort.slug,
    type: cohort.type,
    status: cohort.status,
    organisationId: cohort.organisationId ?? undefined,
    logoUrl: cohort.logoUrl ?? undefined,
    description: cohort.description ?? undefined,
    maxSize: cohort.maxSize ?? undefined,
    startDate: cohort.startDate?.toISOString() ?? undefined,
    endDate: cohort.endDate?.toISOString() ?? undefined,
    metadata: isRecord(cohort.metadata) ? cohort.metadata : {},
    createdAt: cohort.createdAt.toISOString(),
    updatedAt: cohort.updatedAt.toISOString(),
    _count: cohort._count,
    organisation: cohort.organisation ? serializeOrganisationSummary(cohort.organisation) : undefined,
    programmes: cohort.programmes?.map((link) => serializeCohortProgramme(link)) ?? undefined,
    participants:
      cohort.participants?.map((entry) => ({
        id: entry.id,
        participantId: entry.participantId,
        joinedAt: entry.joinedAt.toISOString(),
        participant: entry.participant ? serializeBaseParticipant(entry.participant) : undefined
      })) ?? undefined,
    registrationPages: cohort.registrationPages?.map((page) => serializeRegistrationPage(page)) ?? undefined,
    eventFlow: cohort.eventFlows?.[0]
      ? {
          id: cohort.eventFlows[0].id,
          flow: isRecord(cohort.eventFlows[0].flow) ? cohort.eventFlows[0].flow : {},
          deployedAt: cohort.eventFlows[0].deployedAt?.toISOString() ?? null,
          createdAt: cohort.eventFlows[0].createdAt.toISOString(),
          updatedAt: cohort.eventFlows[0].updatedAt.toISOString(),
          events: cohort.eventFlows[0].events?.map(serializeEvent) ?? []
        }
      : undefined
  };
}

export function serializeCohortProgramme(
  link: CohortProgramme & {
    programme?: Programme;
  }
) {
  return {
    id: link.id,
    cohortId: link.cohortId,
    programmeId: link.programmeId,
    enrolledAt: link.enrolledAt.toISOString(),
    programme: link.programme ? serializeProgramme(link.programme) : undefined
  };
}

export function serializeRegistrationPage(page: RegistrationPage) {
  return {
    id: page.id,
    cohortId: page.cohortId,
    slug: page.slug,
    title: page.title ?? undefined,
    logoUrl: page.logoUrl ?? undefined,
    steps: Array.isArray(page.steps) ? page.steps : [],
    isPublished: page.isPublished,
    expiresAt: page.expiresAt?.toISOString() ?? undefined,
    metadata: isRecord(page.metadata) ? page.metadata : {},
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString()
  };
}

export function serializeFormSubmission(submission: {
  id: string;
  formId: string;
  respondentId: string | null;
  cohortId?: string | null;
  participant?: {
    id: string;
    name: string;
    email: string;
  } | null;
  form?: {
    name: string;
  } | null;
  answers: Prisma.JsonValue;
  metadata: Prisma.JsonValue;
  createdAt: Date;
}) {
  return {
    id: submission.id,
    formId: submission.formId,
    formName: submission.form?.name,
    respondentId: submission.respondentId ?? undefined,
    cohortId: submission.cohortId ?? undefined,
    respondent: submission.participant
      ? {
          id: submission.participant.id,
          name: submission.participant.name,
          email: submission.participant.email,
        }
      : undefined,
    answers: isRecord(submission.answers) ? submission.answers : {},
    metadata: isRecord(submission.metadata) ? submission.metadata : {},
    createdAt: submission.createdAt.toISOString()
  };
}

export function serializeProgrammeTimeline(
  timeline: {
    id: string;
    programmeId: string;
    createdAt: Date;
    updatedAt: Date;
    milestones: Array<{
      id: string;
      title: string;
      description: string | null;
      scheduledAt: Date;
      completedAt: Date | null;
      order: number;
      metadata: Prisma.JsonValue;
    }>;
  }
) {
  return {
    id: timeline.id,
    programmeId: timeline.programmeId,
    createdAt: timeline.createdAt.toISOString(),
    updatedAt: timeline.updatedAt.toISOString(),
    milestones: timeline.milestones.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      description: milestone.description ?? undefined,
      scheduledAt: milestone.scheduledAt.toISOString(),
      completedAt: milestone.completedAt?.toISOString() ?? undefined,
      order: milestone.order,
      metadata: isRecord(milestone.metadata) ? milestone.metadata : {}
    }))
  };
}

export function serializeParticipantRequest(
  request: {
    id: string;
    programmeId: string | null;
    cohortId: string | null;
    participantId: string;
    title: string;
    description: string | null;
    dueDate: Date | null;
    status: string;
    formId: string | null;
    linkUrl: string | null;
    metadata: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
    participant?: { id: string; name: string; email: string };
    form?: { id: string; name: string; slug: string; description?: string | null; status?: string; sections?: Prisma.JsonValue } | null;
    response?: { id: string; content: Prisma.JsonValue; submittedAt: Date } | null;
  }
) {
  return {
    id: request.id,
    programmeId: request.programmeId ?? undefined,
    cohortId: request.cohortId ?? undefined,
    participantId: request.participantId,
    title: request.title,
    description: request.description ?? undefined,
    dueDate: request.dueDate?.toISOString() ?? undefined,
    status: request.status,
    formId: request.formId ?? undefined,
    linkUrl: request.linkUrl ?? undefined,
    metadata: isRecord(request.metadata) ? request.metadata : {},
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    participant: request.participant,
    form: request.form
      ? {
          ...request.form,
          description: request.form.description ?? undefined,
          sections: Array.isArray(request.form.sections) ? request.form.sections : []
        }
      : undefined,
    response: request.response
      ? {
          id: request.response.id,
          content: isRecord(request.response.content) ? request.response.content : {},
          submittedAt: request.response.submittedAt.toISOString()
        }
      : undefined
  };
}

export function serializeDeliverable(
  deliverable: {
    id: string;
    programmeId: string | null;
    cohortId: string | null;
    participantId: string | null;
    title: string;
    description: string | null;
    resourceType: string;
    url: string | null;
    status: string;
    deliveryChannel: string | null;
    scheduledAt: Date | null;
    deliveredAt: Date | null;
    metadata: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
    participant?: { id: string; name: string; email: string } | null;
  }
) {
  return {
    id: deliverable.id,
    programmeId: deliverable.programmeId ?? undefined,
    cohortId: deliverable.cohortId ?? undefined,
    participantId: deliverable.participantId ?? undefined,
    title: deliverable.title,
    description: deliverable.description ?? undefined,
    resourceType: deliverable.resourceType,
    url: deliverable.url ?? undefined,
    status: deliverable.status,
    deliveryChannel: deliverable.deliveryChannel ?? undefined,
    scheduledAt: deliverable.scheduledAt?.toISOString() ?? undefined,
    deliveredAt: deliverable.deliveredAt?.toISOString() ?? undefined,
    metadata: isRecord(deliverable.metadata) ? deliverable.metadata : {},
    createdAt: deliverable.createdAt.toISOString(),
    updatedAt: deliverable.updatedAt.toISOString(),
    participant: deliverable.participant ?? undefined
  };
}

export function serializeParticipantForumThread(
  thread: {
    id: string;
    title: string;
    body: string;
    isPinned: boolean;
    createdAt: Date;
    updatedAt: Date;
    author: { id: string; name: string; email: string };
    replies: Array<{
      id: string;
      body: string;
      parentId: string | null;
      createdAt: Date;
      updatedAt: Date;
      author: { id: string; name: string; email: string };
    }>;
  }
) {
  return {
    id: thread.id,
    title: thread.title,
    body: thread.body,
    isPinned: thread.isPinned,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
    author: thread.author,
    replies: thread.replies.map((reply) => ({
      id: reply.id,
      body: reply.body,
      parentId: reply.parentId ?? undefined,
      createdAt: reply.createdAt.toISOString(),
      updatedAt: reply.updatedAt.toISOString(),
      author: reply.author
    }))
  };
}
