import { z } from "zod";

export const idParamSchema = z.object({ id: z.string().min(1) });
export const programmeQuerySchema = z.object({ programmeId: z.string().optional() });

export const participantDefinitionSchema = z.object({
  fields: z.array(
    z.object({
      key: z.string().min(1),
      label: z.string().min(1),
      type: z.enum(["text", "email", "textarea"]),
      required: z.boolean(),
      visible: z.boolean().default(true)
    })
  )
});

export const eventFlowSchema = z.record(z.string(), z.string());

export const createProgrammeSchema = z.object({
  name: z.string().min(1),
  startDate: z.string().datetime().or(z.string().min(1)),
  eventFlow: eventFlowSchema.optional(),
  participantDefinition: participantDefinitionSchema.optional()
});

export const updateProgrammeSchema = createProgrammeSchema.partial();

export const eventConfigSchema = z.record(z.string(), z.unknown());

export const createEventSchema = z.object({
  name: z.string().min(1),
  programmeId: z.string().min(1),
  baseType: z.enum(["send_email"]),
  instanceType: z.enum(["send_invoice", "send_prework_email", "send_admin_reminder", "send_form"]).optional(),
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
      baseType: z.enum(["send_email"]),
      instanceType: z.enum(["send_invoice", "send_prework_email", "send_admin_reminder", "send_form"]).optional(),
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
  organisation: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  socialLinks: z.array(z.string()).optional(),
  photoId: z.string().optional(),
  paymentStatus: z.enum(["not_invoiced", "invoiced", "paid", "overdue"]).optional(),
  notes: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const updateParticipantSchema = createParticipantSchema.omit({ programmeId: true }).partial().extend({
  stripeCustomerId: z.string().optional(),
  stripeInvoiceIds: z.array(z.string()).optional()
});

export const createInvoiceSchema = z.object({
  programmeId: z.string().min(1),
  participantId: z.string().min(1),
  amount: z.number(),
  currency: z.string().optional(),
  status: z.enum(["draft", "sent", "paid", "overdue"]).optional(),
  dueDate: z.string().datetime().or(z.string().min(1)),
  paidAt: z.string().datetime().or(z.string().min(1)).optional(),
  stripeInvoiceUrl: z.string().optional()
});

export const updateInvoiceSchema = createInvoiceSchema.omit({ programmeId: true, participantId: true }).partial();

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
