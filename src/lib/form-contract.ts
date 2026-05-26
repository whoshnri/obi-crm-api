import { z } from "zod";

export const questionTypeSchema = z.enum([
  "mcq",
  "file_upload",
  "upload_or_text",
  "essay",
  "short_answer",
  "range",
  "phone",
  "date_time",
  "date",
  "time",
  "url",
  "email"
]);

const baseQuestionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean().optional()
});

export const mcqQuestionSchema = baseQuestionSchema.extend({
  type: z.literal("mcq"),
  options: z.array(z.string().min(1)).min(1),
  multiple: z.boolean().optional()
});

export const fileUploadQuestionSchema = baseQuestionSchema.extend({
  type: z.literal("file_upload"),
  acceptedTypes: z.string().optional()
});

export const uploadOrTextQuestionSchema = baseQuestionSchema.extend({
  type: z.literal("upload_or_text"),
  acceptedTypes: z.string().optional(),
  textPlaceholder: z.string().optional(),
  textRows: z.number().int().positive().optional()
});

export const essayQuestionSchema = baseQuestionSchema.extend({
  type: z.literal("essay"),
  wordLimit: z.number().int().positive().optional(),
  placeholder: z.string().optional()
});

export const shortAnswerQuestionSchema = baseQuestionSchema.extend({
  type: z.literal("short_answer"),
  placeholder: z.string().optional()
});

export const rangeQuestionSchema = baseQuestionSchema.extend({
  type: z.literal("range"),
  min: z.number(),
  max: z.number(),
  minLabel: z.string().optional(),
  maxLabel: z.string().optional(),
  scaleLabels: z.array(z.string()).optional()
});

export const phoneQuestionSchema = baseQuestionSchema.extend({
  type: z.literal("phone"),
  placeholder: z.string().optional()
});

export const typedInputQuestionSchema = baseQuestionSchema.extend({
  type: z.enum(["date_time", "date", "time", "url", "email"]),
  placeholder: z.string().optional()
});

export const universalQuestionSchema = z.discriminatedUnion("type", [
  mcqQuestionSchema,
  fileUploadQuestionSchema,
  uploadOrTextQuestionSchema,
  essayQuestionSchema,
  shortAnswerQuestionSchema,
  rangeQuestionSchema,
  phoneQuestionSchema,
  typedInputQuestionSchema
]);

export const lastPageResourceSchema = z.object({
  folderName: z.string().min(1),
  fileName: z.string().min(1),
  fileExtType: z.string().min(1)
});

export const formSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  disclaimer: z.string().optional(),
  questions: z.array(universalQuestionSchema).min(1),
  lastPageResources: z.array(lastPageResourceSchema).optional()
});

export const savedFileSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  url: z.string().min(1),
  storageKey: z.string().min(1)
});

export const phoneAnswerSchema = z.object({
  countryCode: z.string().min(1),
  dialCode: z.string().min(1),
  nationalNumber: z.string()
});

export const uploadOrTextAnswerSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("upload"), file: savedFileSchema.nullable() }),
  z.object({ mode: z.literal("text"), text: z.string() })
]);

export const answerValueSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.number(),
  savedFileSchema,
  uploadOrTextAnswerSchema,
  phoneAnswerSchema,
  z.null()
]);

export const answersSchema = z.record(z.string(), answerValueSchema);

export const formDefinitionSchema = z.object({
  id: z.string().optional(),
  programmeId: z.string().optional().nullable(),
  eventId: z.string().optional().nullable(),
  slug: z.string().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(["draft", "published", "archived"]).default("draft"),
  sections: z.array(formSectionSchema).min(1)
});

export const createFormSchema = formDefinitionSchema.omit({ id: true }).extend({
  programmeId: z.string().min(1),
  eventId: z.string().min(1).optional().nullable()
});

export const updateFormSchema = createFormSchema.partial();

export const createSubmissionSchema = z.object({
  respondentId: z.string().optional().nullable(),
  respondentEmail: z.string().email().optional().nullable(),
  answers: answersSchema,
  metadata: z.record(z.string(), z.unknown()).optional()
});

export type UniversalQuestion = z.infer<typeof universalQuestionSchema>;
export type FormSection = z.infer<typeof formSectionSchema>;
export type FormDefinition = z.infer<typeof formDefinitionSchema>;
export type SavedFile = z.infer<typeof savedFileSchema>;
export type FormAnswers = z.infer<typeof answersSchema>;
export type FormSubmissionInput = z.infer<typeof createSubmissionSchema>;
