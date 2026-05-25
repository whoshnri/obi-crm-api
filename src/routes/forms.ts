import { Hono } from "hono";
import type { Prisma } from "../generated/client";
import { prisma } from "../lib/prisma";
import { handleRoute } from "../lib/http";
import { serializeForm, serializeFormSubmission } from "../lib/serializers";
import { createFormSchema, createSubmissionSchema, updateFormSchema } from "../lib/form-contract";
import { idParamSchema, programmeQuerySchema } from "../lib/schemas";

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
        orderBy: { name: "asc" }
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
        orderBy: { createdAt: "desc" }
      });
      return submissions.map(serializeFormSubmission);
    })
  )
  .post("/:id/submissions", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = createSubmissionSchema.parse(await c.req.json());
      const submission = await prisma.formSubmission.create({
        data: {
          formId: id,
          respondentId: input.respondentId ?? null,
          answers: input.answers as any,
          metadata: (input.metadata ?? {}) as any
        }
      });

      // notify admins of submission
      try {
        const { addNotificationForAdmins } = await import("../lib/notifications");
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
