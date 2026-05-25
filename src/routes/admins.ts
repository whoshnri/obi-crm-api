import { Hono } from "hono";
import { AdminRole } from "../generated/client";
import { prisma } from "../lib/prisma";
import { handleRoute } from "../lib/http";
import { serializeAdmin } from "../lib/serializers";
import { adminInputSchema, idParamSchema, updateAdminSchema } from "../lib/schemas";

export const adminsRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const admins = await prisma.admin.findMany({ orderBy: { createdAt: "asc" } });
      return admins.map(serializeAdmin);
    })
  )
  .get("/primary", (c) =>
    handleRoute(c, async () => {
      const admin = await prisma.admin.findFirst({ orderBy: { createdAt: "asc" } });
      return admin ? serializeAdmin(admin) : null;
    })
  )
  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = adminInputSchema.parse(await c.req.json());
      const admin = await prisma.admin.create({
        data: {
          name: input.name,
          email: input.email,
          role: (input.role ?? "read_only") as AdminRole,
          password: input.password ?? "change-me",
          notificationsEnabled: input.notificationsEnabled ?? true,
          photoId: input.photoId
        }
      });
      return serializeAdmin(admin);
    })
  )
  .patch("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateAdminSchema.parse(await c.req.json());
      const admin = await prisma.admin.update({
        where: { id },
        data: {
          ...input,
          role: input.role as AdminRole | undefined
        }
      });
      return serializeAdmin(admin);
    })
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.admin.delete({ where: { id } });
      return { ok: true };
    })
  );
