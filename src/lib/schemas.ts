import { z } from "zod";

export const idParamSchema = z.object({ id: z.string().min(1) });
export const programmeQuerySchema = z.object({ programmeId: z.string().optional() });
export const eventsQuerySchema = z.object({
  programmeId: z.string().optional(),
  cohortId: z.string().optional()
});

export const eventFlowSchema = z.record(z.string(), z.string());

export const createProgrammeSchema = z.object({
  name: z.string().min(1),
  startDate: z.iso.datetime().or(z.string().min(1)),
  description: z.string().optional().nullable(),
  costPerParticipant: z.number().nonnegative().optional().nullable(),
  ownerAdminId: z.string().min(1),
  registrationResourceId: z.string().min(1).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  eventFlow: eventFlowSchema.optional(),
});

export const updateProgrammeSchema = createProgrammeSchema.partial();

export const eventConfigSchema = z.record(z.string(), z.unknown());

export const createEventSchema = z.object({
  name: z.string().min(1),
  programmeId: z.string().min(1),
  cohortId: z.string().min(1).optional(),
  cohortEventFlowId: z.string().min(1).optional(),
  baseType: z.enum(["send_email", "send_invoice"]),
  status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
  scheduledAt: z.string().datetime().or(z.string().min(1)),
  config: eventConfigSchema.optional()
});

export const updateEventSchema = createEventSchema.omit({ programmeId: true }).partial();

export const saveProgrammeEventFlowStateSchema = z.object({
  eventFlow: eventFlowSchema,
  events: z.array(
    z.object({
      id: z.string().min(1).optional(),
      name: z.string().min(1),
      baseType: z.enum(["send_email", "send_invoice"]),
      status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
      scheduledAt: z.string().datetime().or(z.string().min(1)),
      config: eventConfigSchema.optional()
    })
  )
});

export const formFieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "textarea"]),
  required: z.boolean()
});

export const formEntrySchema = z.object({
  participantId: z.string().min(1),
  submittedAt: z.string().optional(),
  data: z.record(z.string(), z.string())
});

export const createFormTableSchema = z.object({
  programmeId: z.string().min(1),
  eventId: z.string().min(1),
  name: z.string().min(1),
  formSchema: z.array(formFieldSchema).optional(),
  entries: z.array(formEntrySchema).optional()
});

export const updateFormTableSchema = createFormTableSchema
  .omit({ programmeId: true, eventId: true })
  .partial();

export const submitFormEntrySchema = z.object({
  participantId: z.string().min(1),
  data: z.record(z.string(), z.string())
});

export const createParticipantSchema = z.object({
  programmeId: z.string().min(1).optional(),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8).optional(),
  organisation: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  socialLinks: z.array(z.string()).optional(),
  photoId: z.string().optional(),
  paymentStatus: z.enum(["not_invoiced", "invoiced", "paid", "overdue"]).optional(),
  notes: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  programmeParticipantMetadata: z.record(z.string(), z.unknown()).optional()
});

export const updateParticipantSchema = createParticipantSchema.omit({ programmeId: true }).partial().extend({
  stripeCustomerId: z.string().optional()
});

export const invoiceLineItemSchema = z.object({
  description: z.string().min(1),
  amount: z.number(),
  currency: z.string().optional()
});

const invoiceInputSchema = z.object({
  programmeId: z.string().min(1),
  programmeParticipantId: z.string().min(1).optional(),
  participantId: z.string().min(1).optional(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  status: z.enum(["draft", "sent", "paid", "overdue"]).optional(),
  dueDate: z.string().datetime().or(z.string().min(1)),
  paidAt: z.string().datetime().or(z.string().min(1)).optional(),
  stripeInvoiceId: z.string().optional(),
  stripeInvoiceUrl: z.string().optional(),
  stripeInvoiceItemIds: z.array(z.string()).optional(),
  lineItems: z.array(invoiceLineItemSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const createInvoiceSchema = invoiceInputSchema.refine((input) => input.programmeParticipantId || input.participantId, {
  message: "participantId or programmeParticipantId is required"
});

export const updateInvoiceSchema = invoiceInputSchema
  .omit({ programmeId: true, participantId: true, programmeParticipantId: true })
  .partial();

export const createEmailTemplateSchema = z.object({
  programmeId: z.string().min(1),
  name: z.string().min(1),
  subject: z.string(),
  body: z.string()
});

export const updateEmailTemplateSchema = createEmailTemplateSchema.omit({ programmeId: true }).partial();

export const adminInputSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(["super", "standard", "basic", "read_only"]).optional(),
  password: z.string().optional(),
  photoId: z.string().optional(),
  notificationsEnabled: z.boolean().optional()
});

export const updateAdminSchema = adminInputSchema.partial();

export const createOrganisationSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  logoUrl: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  size: z.enum(["solo", "small", "medium", "large", "enterprise"]).optional().nullable(),
  industry: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  contactName: z.string().optional().nullable(),
  contactEmail: z.string().email().optional().nullable(),
  contactPhone: z.string().optional().nullable(),
  parentOrganisationId: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const updateOrganisationSchema = createOrganisationSchema.partial();

export const cohortQuerySchema = z.object({
  organisationId: z.string().optional()
});

export const createCohortSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  type: z.enum(["org_specific", "open"]).optional(),
  status: z.enum(["draft", "active", "completed", "archived"]).optional(),
  organisationId: z.string().optional().nullable(),
  logoUrl: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  maxSize: z.number().int().positive().optional().nullable(),
  startDate: z.iso.datetime().or(z.string().min(1)).optional().nullable(),
  endDate: z.iso.datetime().or(z.string().min(1)).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const updateCohortSchema = createCohortSchema.partial();

export const linkCohortProgrammeSchema = z.object({
  programmeId: z.string().min(1)
});

export const addCohortParticipantSchema = z
  .object({
    participantId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    programmeId: z.string().min(1).optional(),
    organisation: z.string().optional(),
    phone: z.string().optional(),
    address: z.string().optional(),
    notes: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .refine((input) => input.participantId || (input.name && input.email && input.programmeId), {
    message: "Provide participantId or name, email, and programmeId"
  });

export const saveCohortEventFlowSchema = z.object({
  flow: eventFlowSchema,
  deployedAt: z.iso.datetime().or(z.string().min(1)).optional().nullable()
});

export const saveCohortEventFlowStateSchema = z.object({
  programmeId: z.string().min(1).optional(),
  eventFlow: eventFlowSchema,
  events: z.array(
    z.object({
      id: z.string().min(1).optional(),
      name: z.string().min(1),
      baseType: z.enum(["send_email", "send_invoice"]),
      status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
      scheduledAt: z.string().datetime().or(z.string().min(1)),
      config: eventConfigSchema.optional()
    })
  )
});

export const createRegistrationPageSchema = z.object({
  slug: z.string().min(1).optional(),
  title: z.string().optional().nullable(),
  logoUrl: z.string().optional().nullable(),
  steps: z.array(z.unknown()).optional(),
  isPublished: z.boolean().optional(),
  expiresAt: z.iso.datetime().or(z.string().min(1)).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const updateRegistrationPageSchema = createRegistrationPageSchema.partial();

export const registrationPageParamSchema = z.object({
  pageId: z.string().min(1)
});

export const programmeSubmissionsQuerySchema = z.object({
  formId: z.string().optional(),
  cohortId: z.string().optional(),
  respondentId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20)
});
