import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { handleRoute } from "../lib/http";
import { serializeForm, serializeFormSubmission } from "../lib/serializers";
import { createFormSchema, createSubmissionSchema, updateFormSchema } from "../lib/form-contract";
import { idParamSchema, programmeQuerySchema } from "../lib/schemas";

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
      const id = crypto.randomUUID();
      const rows = await prisma.$queryRaw<Array<Parameters<typeof serializeForm>[0]>>`
        INSERT INTO "Form" ("id", "programmeId", "eventId", "slug", "name", "description", "status", "sections")
        VALUES (
          ${id},
          ${input.programmeId ?? null},
          ${input.eventId ?? null},
          ${input.slug},
          ${input.name},
          ${input.description ?? null},
          ${input.status},
          ${JSON.stringify(input.sections)}::jsonb
        )
        RETURNING "id", "programmeId", "eventId", "slug", "name", "description", "status", "sections", "createdAt", "updatedAt"
      `;
      const form = rows[0];
      if (!form) throw new Error("Form was not created.");
      return serializeForm(form);
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
