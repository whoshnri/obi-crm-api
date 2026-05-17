import { Hono } from "hono";
import { prisma } from "../lib/prisma";
import { handleRoute } from "../lib/http";
import { createEmailTemplateSchema, idParamSchema, programmeQuerySchema, updateEmailTemplateSchema } from "../lib/schemas";

export const templatesRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const { programmeId } = programmeQuerySchema.parse(c.req.query());
      return prisma.emailTemplate.findMany({
        where: programmeId ? { programmeId } : undefined,
        include: { programme: { select: { name: true } } },
        orderBy: { name: "asc" }
      });
    })
  )
  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = createEmailTemplateSchema.parse(await c.req.json());
      return prisma.emailTemplate.create({ data: input });
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      return prisma.emailTemplate.findUnique({ where: { id } });
    })
  )
  .patch("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateEmailTemplateSchema.parse(await c.req.json());
      return prisma.emailTemplate.update({ where: { id }, data: input });
    })
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.emailTemplate.delete({ where: { id } });
      return { ok: true };
    })
  );
