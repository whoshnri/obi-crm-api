import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { NotificationType, Prisma, ResourceType, TaskPriority, TaskStatus } from "../generated/client.js";
import { handleRoute } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";

const permissions = [
  "admin_create",
  "admin_update",
  "admin_delete",
  "admin_view",
  "role_create",
  "role_update",
  "role_delete",
  "role_view",
  "role_assign",
  "programme_create",
  "programme_update",
  "programme_delete",
  "programme_view",
  "programme_assign_admin",
  "participant_create",
  "participant_update",
  "participant_delete",
  "participant_view",
  "invoice_create",
  "invoice_update",
  "invoice_delete",
  "invoice_view",
  "invoice_send",
  "event_create",
  "event_update",
  "event_delete",
  "event_view",
  "event_trigger",
  "form_create",
  "form_update",
  "form_delete",
  "form_view",
  "form_submissions_view",
  "opportunity_create",
  "opportunity_update",
  "opportunity_delete",
  "opportunity_view",
  "comms_post",
  "comms_delete",
  "comms_view",
  "comms_tag",
  "task_create",
  "task_update",
  "task_delete",
  "task_view",
  "task_assign",
  "resource_create",
  "resource_update",
  "resource_delete",
  "resource_view",
  "notification_view",
  "notification_manage",
  "org_settings_view",
  "org_settings_update"
] as const;

const notificationTypes = [
  "form_submission",
  "form_submitted",
  "event_run",
  "event_deployed",
  "event_failed",
  "event_completed",
  "payment_received",
  "payment_overdue",
  "invoice_sent",
  "invoice_created",
  "participant_added",
  "participant_updated",
  "participant_enrolled",
  "programme_update",
  "task_assigned",
  "task_completed",
  "comms_tag",
  "admin_added",
  "opportunity_converted",
  "error",
  "info"
] as const;

const idParamSchema = z.object({ id: z.string().min(1) });
const roleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  isSystem: z.boolean().optional(),
  permissions: z.array(z.enum(permissions)).optional()
});
const updateRoleSchema = roleSchema.partial();

const adminRoleSchema = z.object({
  roleId: z.string().min(1).nullable()
});

const assignmentSchema = z.object({
  adminId: z.string().min(1),
  programmeId: z.string().min(1),
  roleId: z.string().min(1).optional().nullable()
});
const updateAssignmentSchema = assignmentSchema.omit({ adminId: true, programmeId: true }).partial();
const assignmentQuerySchema = z.object({
  adminId: z.string().optional(),
  programmeId: z.string().optional()
});

const threadSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  isPinned: z.boolean().optional(),
  authorId: z.string().min(1).optional(),
  tagAdminIds: z.array(z.string().min(1)).optional()
});
const updateThreadSchema = threadSchema.omit({ authorId: true, tagAdminIds: true }).partial();

const replySchema = z.object({
  body: z.string().min(1),
  authorId: z.string().min(1).optional(),
  parentId: z.string().min(1).optional().nullable()
});
const updateReplySchema = replySchema.omit({ authorId: true, parentId: true }).partial();

const tagsSchema = z.object({
  adminIds: z.array(z.string().min(1)).default([])
});

const taskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  programmeId: z.string().min(1).optional().nullable(),
  assigneeId: z.string().min(1).optional().nullable(),
  createdById: z.string().min(1).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  status: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]).optional(),
  dueDate: z.string().min(1).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
const updateTaskSchema = taskSchema.omit({ createdById: true }).partial();
const taskQuerySchema = z.object({
  programmeId: z.string().optional(),
  assigneeId: z.string().optional(),
  status: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]).optional()
});

const taskItemSchema = z.object({
  label: z.string().min(1),
  completed: z.boolean().optional(),
  assigneeId: z.string().min(1).optional().nullable(),
  order: z.number().int().optional()
});
const updateTaskItemSchema = taskItemSchema.partial();

const resourceSchema = z.object({
  programmeId: z.string().min(1),
  label: z.string().min(1),
  url: z.string().min(1),
  type: z.enum(["link", "document", "video", "spreadsheet", "image", "other"]).optional(),
  description: z.string().optional().nullable(),
  addedById: z.string().min(1).optional().nullable()
});
const updateResourceSchema = resourceSchema.omit({ programmeId: true }).partial();

const notificationSchema = z.object({
  adminId: z.string().min(1),
  type: z.enum(notificationTypes),
  title: z.string().min(1),
  body: z.string().optional().nullable(),
  read: z.boolean().optional(),
  payload: z.record(z.string(), z.unknown()).optional()
});
const updateNotificationSchema = notificationSchema.omit({ adminId: true }).partial();
const notificationQuerySchema = z.object({
  adminId: z.string().optional(),
  read: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true"))
});

function currentAdminId(c: Context) {
  return ((c as any).get("admin") as { sub?: string } | undefined)?.sub;
}

function dateOrNull(value: string | null | undefined) {
  return value ? new Date(value) : value === null ? null : undefined;
}

function jsonInput(value: Record<string, unknown> | undefined, fallback: Record<string, unknown> = {}) {
  return (value ?? fallback) as Prisma.InputJsonValue;
}

const adminSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  roleId: true
} as const;

const orgThreadInclude = {
  author: { select: adminSelect },
  tags: { include: { admin: { select: adminSelect } } },
  replies: {
    include: { author: { select: adminSelect }, children: true },
    orderBy: { createdAt: "asc" as const }
  }
};

const programmeThreadInclude = {
  author: { select: adminSelect },
  tags: { include: { admin: { select: adminSelect } } },
  replies: {
    include: { author: { select: adminSelect }, children: true },
    orderBy: { createdAt: "asc" as const }
  }
};

export const orgRouter = new Hono()
  .get("/permissions", (c) => handleRoute(c, () => permissions))
  .get("/roles", (c) =>
    handleRoute(c, async () => prisma.role.findMany({ orderBy: [{ isSystem: "desc" }, { name: "asc" }] }))
  )
  .post("/roles", (c) =>
    handleRoute(c, async () => {
      const input = roleSchema.parse(await c.req.json());
      return prisma.role.create({
        data: {
          name: input.name,
          description: input.description,
          isSystem: input.isSystem ?? false,
          permissions: input.permissions ?? []
        }
      });
    })
  )
  .patch("/roles/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateRoleSchema.parse(await c.req.json());
      return prisma.role.update({
        where: { id },
        data: {
          name: input.name,
          description: input.description,
          isSystem: input.isSystem,
          permissions: input.permissions
        }
      });
    })
  )
  .delete("/roles/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.role.delete({ where: { id } });
      return { ok: true };
    })
  )
  .patch("/admins/:id/role", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = adminRoleSchema.parse(await c.req.json());
      return prisma.admin.update({
        where: { id },
        data: { roleId: input.roleId },
        select: adminSelect
      });
    })
  )
  .get("/programme-assignments", (c) =>
    handleRoute(c, async () => {
      const query = assignmentQuerySchema.parse(c.req.query());
      return prisma.adminProgrammeAssignment.findMany({
        where: {
          adminId: query.adminId,
          programmeId: query.programmeId
        },
        include: {
          admin: { select: adminSelect },
          programme: { select: { id: true, name: true } },
          role: true
        },
        orderBy: { assignedAt: "desc" }
      });
    })
  )
  .post("/programme-assignments", (c) =>
    handleRoute(c, async () => {
      const input = assignmentSchema.parse(await c.req.json());
      return prisma.adminProgrammeAssignment.upsert({
        where: { adminId_programmeId: { adminId: input.adminId, programmeId: input.programmeId } },
        create: input,
        update: { roleId: input.roleId },
        include: {
          admin: { select: adminSelect },
          programme: { select: { id: true, name: true } },
          role: true
        }
      });
    })
  )
  .patch("/programme-assignments/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateAssignmentSchema.parse(await c.req.json());
      return prisma.adminProgrammeAssignment.update({
        where: { id },
        data: { roleId: input.roleId },
        include: { admin: { select: adminSelect }, programme: { select: { id: true, name: true } }, role: true }
      });
    })
  )
  .delete("/programme-assignments/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.adminProgrammeAssignment.delete({ where: { id } });
      return { ok: true };
    })
  )
  .get("/comms/threads", (c) =>
    handleRoute(c, async () =>
      prisma.orgCommsThread.findMany({
        include: orgThreadInclude,
        orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }]
      })
    )
  )
  .post("/comms/threads", (c) =>
    handleRoute(c, async () => {
      const input = threadSchema.parse(await c.req.json());
      const authorId = input.authorId ?? currentAdminId(c);
      if (!authorId) return c.json({ error: "Missing author" }, 400);

      return prisma.orgCommsThread.create({
        data: {
          title: input.title,
          body: input.body,
          isPinned: input.isPinned ?? false,
          authorId,
          tags: input.tagAdminIds?.length
            ? { createMany: { data: input.tagAdminIds.map((adminId) => ({ adminId })), skipDuplicates: true } }
            : undefined
        },
        include: orgThreadInclude
      });
    })
  )
  .get("/comms/threads/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      return prisma.orgCommsThread.findUnique({ where: { id }, include: orgThreadInclude });
    })
  )
  .patch("/comms/threads/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateThreadSchema.parse(await c.req.json());
      return prisma.orgCommsThread.update({
        where: { id },
        data: input,
        include: orgThreadInclude
      });
    })
  )
  .delete("/comms/threads/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.orgCommsThread.delete({ where: { id } });
      return { ok: true };
    })
  )
  .post("/comms/threads/:id/tags", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = tagsSchema.parse(await c.req.json());
      await prisma.orgCommsTag.createMany({
        data: input.adminIds.map((adminId) => ({ threadId: id, adminId })),
        skipDuplicates: true
      });
      return prisma.orgCommsThread.findUnique({ where: { id }, include: orgThreadInclude });
    })
  )
  .delete("/comms/threads/:threadId/tags/:adminId", (c) =>
    handleRoute(c, async () => {
      const { threadId, adminId } = c.req.param();
      await prisma.orgCommsTag.delete({ where: { threadId_adminId: { threadId, adminId } } });
      return { ok: true };
    })
  )
  .post("/comms/threads/:id/replies", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = replySchema.parse(await c.req.json());
      const authorId = input.authorId ?? currentAdminId(c);
      if (!authorId) return c.json({ error: "Missing author" }, 400);
      return prisma.orgCommsReply.create({
        data: { threadId: id, body: input.body, parentId: input.parentId, authorId },
        include: { author: { select: adminSelect }, children: true }
      });
    })
  )
  .patch("/comms/replies/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateReplySchema.parse(await c.req.json());
      return prisma.orgCommsReply.update({
        where: { id },
        data: input,
        include: { author: { select: adminSelect }, children: true }
      });
    })
  )
  .delete("/comms/replies/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.orgCommsReply.delete({ where: { id } });
      return { ok: true };
    })
  )
  .get("/programmes/:programmeId/comms", (c) =>
    handleRoute(c, async () => {
      const { programmeId } = c.req.param();
      return prisma.programmeCommsChannel.upsert({
        where: { programmeId },
        create: { programmeId },
        update: {},
        include: {
          programme: { select: { id: true, name: true } },
          threads: { include: programmeThreadInclude, orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }] }
        }
      });
    })
  )
  .post("/programmes/:programmeId/comms/threads", (c) =>
    handleRoute(c, async () => {
      const { programmeId } = c.req.param();
      const input = threadSchema.parse(await c.req.json());
      const authorId = input.authorId ?? currentAdminId(c);
      if (!authorId) return c.json({ error: "Missing author" }, 400);
      const channel = await prisma.programmeCommsChannel.upsert({
        where: { programmeId },
        create: { programmeId },
        update: {}
      });
      return prisma.programmeCommsThread.create({
        data: {
          channelId: channel.id,
          authorId,
          title: input.title,
          body: input.body,
          isPinned: input.isPinned ?? false,
          tags: input.tagAdminIds?.length
            ? { createMany: { data: input.tagAdminIds.map((adminId) => ({ adminId })), skipDuplicates: true } }
            : undefined
        },
        include: programmeThreadInclude
      });
    })
  )
  .patch("/programme-comms/threads/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateThreadSchema.parse(await c.req.json());
      return prisma.programmeCommsThread.update({ where: { id }, data: input, include: programmeThreadInclude });
    })
  )
  .delete("/programme-comms/threads/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.programmeCommsThread.delete({ where: { id } });
      return { ok: true };
    })
  )
  .post("/programme-comms/threads/:id/tags", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = tagsSchema.parse(await c.req.json());
      await prisma.programmeCommsTag.createMany({
        data: input.adminIds.map((adminId) => ({ threadId: id, adminId })),
        skipDuplicates: true
      });
      return prisma.programmeCommsThread.findUnique({ where: { id }, include: programmeThreadInclude });
    })
  )
  .delete("/programme-comms/threads/:threadId/tags/:adminId", (c) =>
    handleRoute(c, async () => {
      const { threadId, adminId } = c.req.param();
      await prisma.programmeCommsTag.delete({ where: { threadId_adminId: { threadId, adminId } } });
      return { ok: true };
    })
  )
  .post("/programme-comms/threads/:id/replies", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = replySchema.parse(await c.req.json());
      const authorId = input.authorId ?? currentAdminId(c);
      if (!authorId) return c.json({ error: "Missing author" }, 400);
      return prisma.programmeCommsReply.create({
        data: { threadId: id, body: input.body, parentId: input.parentId, authorId },
        include: { author: { select: adminSelect }, children: true }
      });
    })
  )
  .patch("/programme-comms/replies/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateReplySchema.parse(await c.req.json());
      return prisma.programmeCommsReply.update({
        where: { id },
        data: input,
        include: { author: { select: adminSelect }, children: true }
      });
    })
  )
  .delete("/programme-comms/replies/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.programmeCommsReply.delete({ where: { id } });
      return { ok: true };
    })
  )
  .get("/tasks", (c) =>
    handleRoute(c, async () => {
      const query = taskQuerySchema.parse(c.req.query());
      return prisma.task.findMany({
        where: {
          programmeId: query.programmeId,
          assigneeId: query.assigneeId,
          status: query.status as TaskStatus | undefined
        },
        include: {
          assignee: { select: adminSelect },
          createdBy: { select: adminSelect },
          programme: { select: { id: true, name: true } },
          items: { orderBy: { order: "asc" }, include: { assignee: { select: adminSelect } } }
        },
        orderBy: [{ status: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }]
      });
    })
  )
  .post("/tasks", (c) =>
    handleRoute(c, async () => {
      const input = taskSchema.parse(await c.req.json());
      const createdById = input.createdById ?? currentAdminId(c);
      if (!createdById) return c.json({ error: "Missing task creator" }, 400);
      return prisma.task.create({
        data: {
          title: input.title,
          description: input.description,
          programmeId: input.programmeId,
          assigneeId: input.assigneeId,
          createdById,
          priority: input.priority as TaskPriority | undefined,
          status: input.status as TaskStatus | undefined,
          dueDate: dateOrNull(input.dueDate),
          metadata: jsonInput(input.metadata)
        },
        include: { assignee: { select: adminSelect }, createdBy: { select: adminSelect }, items: true }
      });
    })
  )
  .get("/tasks/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      return prisma.task.findUnique({
        where: { id },
        include: {
          assignee: { select: adminSelect },
          createdBy: { select: adminSelect },
          programme: { select: { id: true, name: true } },
          items: { orderBy: { order: "asc" }, include: { assignee: { select: adminSelect } } }
        }
      });
    })
  )
  .patch("/tasks/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateTaskSchema.parse(await c.req.json());
      return prisma.task.update({
        where: { id },
        data: {
          title: input.title,
          description: input.description,
          programmeId: input.programmeId,
          assigneeId: input.assigneeId,
          priority: input.priority as TaskPriority | undefined,
          status: input.status as TaskStatus | undefined,
          dueDate: dateOrNull(input.dueDate),
          metadata: input.metadata === undefined ? undefined : jsonInput(input.metadata)
        },
        include: { assignee: { select: adminSelect }, createdBy: { select: adminSelect }, items: true }
      });
    })
  )
  .delete("/tasks/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.task.delete({ where: { id } });
      return { ok: true };
    })
  )
  .post("/tasks/:id/items", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = taskItemSchema.parse(await c.req.json());
      return prisma.taskItem.create({
        data: {
          taskId: id,
          label: input.label,
          completed: input.completed ?? false,
          assigneeId: input.assigneeId,
          order: input.order ?? 0
        },
        include: { assignee: { select: adminSelect } }
      });
    })
  )
  .patch("/task-items/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateTaskItemSchema.parse(await c.req.json());
      return prisma.taskItem.update({
        where: { id },
        data: input,
        include: { assignee: { select: adminSelect } }
      });
    })
  )
  .delete("/task-items/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.taskItem.delete({ where: { id } });
      return { ok: true };
    })
  )
  .get("/programmes/:programmeId/resources", (c) =>
    handleRoute(c, async () => {
      const { programmeId } = c.req.param();
      return prisma.programmeResource.findMany({
        where: { programmeId },
        include: { addedBy: { select: adminSelect } },
        orderBy: { createdAt: "desc" }
      });
    })
  )
  .post("/programmes/:programmeId/resources", (c) =>
    handleRoute(c, async () => {
      const { programmeId } = c.req.param();
      const raw = await c.req.json();
      const input = resourceSchema.parse({ ...raw, programmeId });
      return prisma.programmeResource.create({
        data: {
          programmeId,
          label: input.label,
          url: input.url,
          type: input.type as ResourceType | undefined,
          description: input.description,
          addedById: input.addedById ?? currentAdminId(c) ?? null
        },
        include: { addedBy: { select: adminSelect } }
      });
    })
  )
  .patch("/resources/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateResourceSchema.parse(await c.req.json());
      return prisma.programmeResource.update({
        where: { id },
        data: {
          label: input.label,
          url: input.url,
          type: input.type as ResourceType | undefined,
          description: input.description,
          addedById: input.addedById
        },
        include: { addedBy: { select: adminSelect } }
      });
    })
  )
  .delete("/resources/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.programmeResource.delete({ where: { id } });
      return { ok: true };
    })
  )
  .get("/notifications", (c) =>
    handleRoute(c, async () => {
      const query = notificationQuerySchema.parse(c.req.query());
      const adminId = query.adminId ?? currentAdminId(c);
      return prisma.notification.findMany({
        where: {
          adminId,
          read: query.read
        },
        orderBy: { createdAt: "desc" }
      });
    })
  )
  .post("/notifications", (c) =>
    handleRoute(c, async () => {
      const input = notificationSchema.parse(await c.req.json());
      return prisma.notification.create({
        data: {
          adminId: input.adminId,
          type: input.type as NotificationType,
          title: input.title,
          body: input.body,
          read: input.read ?? false,
          payload: jsonInput(input.payload)
        }
      });
    })
  )
  .post("/notifications/seen", (c) =>
    handleRoute(c, async () => {
      const adminId = currentAdminId(c);
      if (!adminId) return { ok: false };
      await prisma.notification.updateMany({ where: { adminId, read: false }, data: { read: true } });
      return { ok: true };
    })
  )
  .patch("/notifications/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateNotificationSchema.parse(await c.req.json());
      return prisma.notification.update({
        where: { id },
        data: {
          type: input.type as NotificationType | undefined,
          title: input.title,
          body: input.body,
          read: input.read,
          payload: input.payload === undefined ? undefined : jsonInput(input.payload)
        }
      });
    })
  )
  .delete("/notifications/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.notification.delete({ where: { id } });
      return { ok: true };
    })
  );
