import { Hono } from "hono";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { handleRoute } from "../lib/http.js";
import { serializeForm, serializeFormSubmission } from "../lib/serializers.js";
import { createFormSchema, createSubmissionSchema, updateFormSchema } from "../lib/form-contract.js";
import { idParamSchema, programmeQuerySchema } from "../lib/schemas.js";
import { trackAnalyticsEvent } from "../lib/analytics.js";

function isDuplicateFormSlugError(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const prismaError = error as { code?: string; meta?: { target?: unknown } };
  return prismaError.code === "P2002" && Array.isArray(prismaError.meta?.target) && prismaError.meta.target.includes("slug");
}

export const formsRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const { programmeId } = programmeQuerySchema.parse(c.req.query());
      const forms = await prisma.form.findMany({
        where: programmeId ? { programmeId } : undefined,
        orderBy: { name: "asc" },
        include: {
          _count: {
            select: { submissions: true }
          }
        }
      });
      return forms.map(serializeForm);
    })
  )
  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = createFormSchema.parse(await c.req.json());
      try {
        const form = await prisma.form.create({
          data: {
            programmeId: input.programmeId,
            eventId: input.eventId ?? null,
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            status: input.status,
            sections: input.sections as Prisma.InputJsonValue
          }
        });
        return serializeForm(form);
      } catch (error) {
        if (isDuplicateFormSlugError(error)) {
          return c.json({ error: "A form with this slug already exists." }, 409);
        }
        throw error;
      }
    })
  )
  .get("/slug/:slug", (c) =>
    handleRoute(c, async () => {
      const slug = c.req.param("slug");
      const form = await prisma.form.findUnique({ where: { slug } });
      return form ? serializeForm(form) : null;
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const form = await prisma.form.findUnique({ where: { id } });
      return form ? serializeForm(form) : null;
    })
  )
  .patch("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateFormSchema.parse(await c.req.json());
      const form = await prisma.form.update({
        where: { id },
        data: {
          programmeId: input.programmeId,
          eventId: input.eventId,
          slug: input.slug,
          name: input.name,
          description: input.description,
          status: input.status,
          sections: input.sections
        }
      });
      return serializeForm(form);
    })
  )
  .post("/:id/publish", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const form = await prisma.form.update({ where: { id }, data: { status: "published" } });
      return serializeForm(form);
    })
  )
  .get("/:id/submissions", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const submissions = await prisma.formSubmission.findMany({
        where: { formId: id },
        include: {
          participant: {
            select: {
              id: true,
              name: true,
              email: true
            }
          }
        },
        orderBy: { createdAt: "desc" }
      });
      return submissions.map(serializeFormSubmission);
    })
  )
  .post("/:id/submissions", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = createSubmissionSchema.parse(await c.req.json());
      const form = await prisma.form.findUnique({
        where: { id },
        select: { id: true, programmeId: true, cohortId: true }
      });

      if (!form) {
        return c.json({ error: "Form not found" }, 404);
      }

      let respondentId = input.respondentId ?? null;
      if (input.respondentEmail) {
        const normalizedEmail = input.respondentEmail.trim().toLowerCase();
        const participant = await prisma.participant.findFirst({
          where: form.programmeId
            ? {
                email: normalizedEmail,
                programmes: {
                  some: {
                    programmeId: form.programmeId
                  }
                }
              }
            : {
                email: normalizedEmail
              },
          select: {
            id: true
          }
        });

        if (!participant) {
          return c.json({ error: "No participant found for that email in this programme." }, 422);
        }

        respondentId = participant.id;
      }

      const submission = await prisma.formSubmission.create({
        data: {
          formId: id,
          respondentId,
          answers: input.answers as any,
          metadata: (input.metadata ?? {}) as any
        },
        include: {
          participant: {
            select: {
              id: true,
              name: true,
              email: true
            }
          }
        }
      });

      if (respondentId) {
        const linkedRequest = await prisma.participantRequest.findFirst({
          where: {
            formId: id,
            participantId: respondentId,
            status: {
              in: ["pending", "in_progress", "rejected"]
            }
          },
          orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }]
        });

        if (linkedRequest) {
          await prisma.$transaction([
            prisma.participantRequest.update({
              where: { id: linkedRequest.id },
              data: { status: "submitted" }
            }),
            prisma.participantRequestResponse.upsert({
              where: { requestId: linkedRequest.id },
              create: {
                requestId: linkedRequest.id,
                content: {
                  type: "form_submission",
                  submissionId: submission.id
                } as Prisma.InputJsonValue
              },
              update: {
                content: {
                  type: "form_submission",
                  submissionId: submission.id
                } as Prisma.InputJsonValue,
                submittedAt: new Date()
              }
            })
          ]);
        }
      }

      void trackAnalyticsEvent({
        type: "form_submitted",
        participantId: respondentId ?? undefined,
        programmeId: form.programmeId ?? undefined,
        cohortId: form.cohortId ?? undefined,
        payload: {
          formId: id,
          submissionId: submission.id
        }
      }).catch((error) => console.error("failed to track form_submitted", error));

      // notify admins of submission
      try {
        const { addNotificationForAdmins } = await import("../lib/notifications.js");
        await addNotificationForAdmins({
          type: "form_submitted",
          title: "Form submitted",
          message: `New submission for form ${id}`,
          meta: { formId: id, submissionId: submission.id }
        });
      } catch (err) {
        console.error("failed to add form submission notification", err);
      }

      return serializeFormSubmission(submission);
    })
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.form.delete({ where: { id } });
      return { ok: true };
    })
  );
