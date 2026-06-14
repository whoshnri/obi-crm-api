import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { handleRoute } from "../lib/http.js";
import {
  emailTemplateCreateData,
  emailTemplateUpdateData,
  serializeEmailTemplate
} from "../lib/email/template-serializer.js";
import { sendTemplateTestEmail } from "../lib/email/send-batch.js";
import { getAuthenticatedAdmin } from "../lib/auth.js";
import { createEmailTemplateSchema, idParamSchema, programmeQuerySchema, updateEmailTemplateSchema } from "../lib/schemas.js";

export const templatesRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const { programmeId } = programmeQuerySchema.parse(c.req.query());
      const templates = await prisma.emailTemplate.findMany({
        where: programmeId ? { programmeId } : undefined,
        orderBy: [{ updatedAt: "desc" }, { name: "asc" }]
      });
      return templates.map(serializeEmailTemplate);
    })
  )
  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = createEmailTemplateSchema.parse(await c.req.json());
      const template = await prisma.emailTemplate.create({
        data: emailTemplateCreateData(input)
      });
      return serializeEmailTemplate(template);
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const template = await prisma.emailTemplate.findUnique({ where: { id } });
      return template ? serializeEmailTemplate(template) : null;
    })
  )
  .patch("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateEmailTemplateSchema.parse(await c.req.json());
      const template = await prisma.emailTemplate.update({
        where: { id },
        data: emailTemplateUpdateData(input)
      });
      return serializeEmailTemplate(template);
    })
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.emailTemplate.delete({ where: { id } });
      return { ok: true };
    })
  )
  .post("/:id/test-send", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const admin = getAuthenticatedAdmin(c);

      const template = await prisma.emailTemplate.findUnique({ where: { id } });
      if (!template) throw new Error("Template not found");

      await sendTemplateTestEmail({
        template,
        to: admin.email,
        toName: admin.email
      });

      return { ok: true, sentTo: admin.email };
    })
  );
