import type { Hono } from "hono";
import { z } from "zod";
import { DeliverableStatus, ParticipantRequestStatus, Prisma, ResourceType } from "../generated/client.js";
import { handleRoute } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import {
  serializeDeliverable,
  serializeParticipantRequest,
  serializeProgrammeTimeline
} from "../lib/serializers.js";

const milestoneSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  scheduledAt: z.string().datetime().or(z.string().min(1)),
  completedAt: z.string().datetime().or(z.string().min(1)).optional().nullable(),
  order: z.number().int().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const updateMilestoneSchema = milestoneSchema.partial();

const createRequestSchema = z.object({
  participantId: z.string().min(1).optional(),
  cohortId: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  dueDate: z.string().datetime().or(z.string().min(1)).optional().nullable(),
  formId: z.string().min(1).optional().nullable(),
  status: z
    .enum(["pending", "in_progress", "submitted", "reviewed", "approved", "rejected"])
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const updateRequestSchema = createRequestSchema.omit({ participantId: true, cohortId: true }).partial();

const createDeliverableSchema = z.object({
  participantId: z.string().min(1).optional().nullable(),
  cohortId: z.string().min(1).optional().nullable(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  resourceType: z
    .enum(["link", "document", "video", "spreadsheet", "image", "other"])
    .optional(),
  url: z.string().optional().nullable(),
  status: z.enum(["pending", "ready", "delivered", "acknowledged"]).optional(),
  scheduledAt: z.string().datetime().or(z.string().min(1)).optional().nullable(),
  deliveredAt: z.string().datetime().or(z.string().min(1)).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const updateDeliverableSchema = createDeliverableSchema.partial();

function parseDate(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

async function assertProgramme(programmeId: string) {
  const programme = await prisma.programme.findUnique({ where: { id: programmeId }, select: { id: true } });
  if (!programme) return null;
  return programme;
}

async function resolveRequestTargets(
  programmeId: string,
  input: z.infer<typeof createRequestSchema>
) {
  if (input.participantId) {
    return [input.participantId];
  }

  if (input.cohortId) {
    const members = await prisma.cohortParticipant.findMany({
      where: {
        cohortId: input.cohortId,
        participant: {
          programmes: { some: { programmeId } }
        }
      },
      select: { participantId: true }
    });
    return members.map((m) => m.participantId);
  }

  const enrolments = await prisma.programmeParticipant.findMany({
    where: { programmeId },
    select: { participantId: true }
  });
  return enrolments.map((e) => e.participantId);
}

const requestInclude = {
  participant: { select: { id: true, name: true, email: true } },
  form: { select: { id: true, name: true, slug: true } },
  response: true
} as const;

export function registerProgrammeDeliveryRoutes(router: Hono) {
  router
    .get("/:programmeId/timeline", (c) =>
      handleRoute(c, async () => {
        const programmeId = c.req.param("programmeId");
        if (!(await assertProgramme(programmeId))) return c.json({ error: "Programme not found" }, 404);

        const timeline = await prisma.programmeTimeline.findUnique({
          where: { programmeId },
          include: {
            milestones: { orderBy: [{ order: "asc" }, { scheduledAt: "asc" }] }
          }
        });

        return timeline ? serializeProgrammeTimeline(timeline) : null;
      })
    )
    .put("/:programmeId/timeline", (c) =>
      handleRoute(c, async () => {
        const programmeId = c.req.param("programmeId");
        if (!(await assertProgramme(programmeId))) return c.json({ error: "Programme not found" }, 404);

        const timeline = await prisma.programmeTimeline.upsert({
          where: { programmeId },
          create: { programmeId },
          update: {},
          include: {
            milestones: { orderBy: [{ order: "asc" }, { scheduledAt: "asc" }] }
          }
        });

        return serializeProgrammeTimeline(timeline);
      })
    )
    .post("/:programmeId/timeline/milestones", (c) =>
      handleRoute(c, async () => {
        const programmeId = c.req.param("programmeId");
        if (!(await assertProgramme(programmeId))) return c.json({ error: "Programme not found" }, 404);
        const input = milestoneSchema.parse(await c.req.json());

        const timeline = await prisma.programmeTimeline.upsert({
          where: { programmeId },
          create: { programmeId },
          update: {}
        });

        const milestone = await prisma.timelineMilestone.create({
          data: {
            timelineId: timeline.id,
            title: input.title,
            description: input.description ?? null,
            scheduledAt: new Date(input.scheduledAt),
            completedAt: parseDate(input.completedAt ?? undefined) ?? null,
            order: input.order ?? 0,
            metadata: (input.metadata ?? {}) as Prisma.InputJsonValue
          }
        });

        return milestone;
      })
    )
    .patch("/:programmeId/timeline/milestones/:milestoneId", (c) =>
      handleRoute(c, async () => {
        const { programmeId, milestoneId } = c.req.param();
        const input = updateMilestoneSchema.parse(await c.req.json());

        const milestone = await prisma.timelineMilestone.findFirst({
          where: { id: milestoneId, timeline: { programmeId } }
        });
        if (!milestone) return c.json({ error: "Milestone not found" }, 404);

        const updated = await prisma.timelineMilestone.update({
          where: { id: milestoneId },
          data: {
            title: input.title,
            description: input.description,
            scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
            completedAt: input.completedAt !== undefined ? parseDate(input.completedAt) : undefined,
            order: input.order,
            metadata: input.metadata as Prisma.InputJsonValue | undefined
          }
        });

        return updated;
      })
    )
    .delete("/:programmeId/timeline/milestones/:milestoneId", (c) =>
      handleRoute(c, async () => {
        const { programmeId, milestoneId } = c.req.param();
        const milestone = await prisma.timelineMilestone.findFirst({
          where: { id: milestoneId, timeline: { programmeId } }
        });
        if (!milestone) return c.json({ error: "Milestone not found" }, 404);
        await prisma.timelineMilestone.delete({ where: { id: milestoneId } });
        return { ok: true };
      })
    )
    .get("/:programmeId/requests", (c) =>
      handleRoute(c, async () => {
        const programmeId = c.req.param("programmeId");
        const cohortId = c.req.query("cohortId");
        if (!(await assertProgramme(programmeId))) return c.json({ error: "Programme not found" }, 404);

        const requests = await prisma.participantRequest.findMany({
          where: {
            programmeId,
            ...(cohortId ? { cohortId } : {})
          },
          include: requestInclude,
          orderBy: { createdAt: "desc" }
        });

        return requests.map(serializeParticipantRequest);
      })
    )
    .post("/:programmeId/requests", (c) =>
      handleRoute(c, async () => {
        const programmeId = c.req.param("programmeId");
        if (!(await assertProgramme(programmeId))) return c.json({ error: "Programme not found" }, 404);
        const input = createRequestSchema.parse(await c.req.json());

        const participantIds = await resolveRequestTargets(programmeId, input);
        if (!participantIds.length) return c.json({ error: "No participants matched" }, 400);

        const created = await prisma.$transaction(
          participantIds.map((participantId) =>
            prisma.participantRequest.create({
              data: {
                programmeId,
                cohortId: input.cohortId ?? null,
                participantId,
                title: input.title,
                description: input.description ?? null,
                dueDate: parseDate(input.dueDate ?? undefined) ?? null,
                formId: input.formId ?? null,
                status: (input.status ?? "pending") as ParticipantRequestStatus,
                metadata: (input.metadata ?? {}) as Prisma.InputJsonValue
              },
              include: requestInclude
            })
          )
        );

        return created.map(serializeParticipantRequest);
      })
    )
    .patch("/:programmeId/requests/:requestId", (c) =>
      handleRoute(c, async () => {
        const { programmeId, requestId } = c.req.param();
        const input = updateRequestSchema.parse(await c.req.json());

        const existing = await prisma.participantRequest.findFirst({
          where: { id: requestId, programmeId }
        });
        if (!existing) return c.json({ error: "Request not found" }, 404);

        const updated = await prisma.participantRequest.update({
          where: { id: requestId },
          data: {
            title: input.title,
            description: input.description,
            dueDate: input.dueDate !== undefined ? parseDate(input.dueDate) : undefined,
            formId: input.formId,
            status: input.status as ParticipantRequestStatus | undefined,
            metadata: input.metadata as Prisma.InputJsonValue | undefined
          },
          include: requestInclude
        });

        return serializeParticipantRequest(updated);
      })
    )
    .delete("/:programmeId/requests/:requestId", (c) =>
      handleRoute(c, async () => {
        const { programmeId, requestId } = c.req.param();
        const existing = await prisma.participantRequest.findFirst({
          where: { id: requestId, programmeId }
        });
        if (!existing) return c.json({ error: "Request not found" }, 404);
        await prisma.participantRequest.delete({ where: { id: requestId } });
        return { ok: true };
      })
    )
    .get("/:programmeId/deliverables", (c) =>
      handleRoute(c, async () => {
        const programmeId = c.req.param("programmeId");
        const cohortId = c.req.query("cohortId");
        if (!(await assertProgramme(programmeId))) return c.json({ error: "Programme not found" }, 404);

        const deliverables = await prisma.deliverable.findMany({
          where: {
            programmeId,
            ...(cohortId ? { cohortId } : {})
          },
          include: {
            participant: { select: { id: true, name: true, email: true } }
          },
          orderBy: { createdAt: "desc" }
        });

        return deliverables.map(serializeDeliverable);
      })
    )
    .post("/:programmeId/deliverables", (c) =>
      handleRoute(c, async () => {
        const programmeId = c.req.param("programmeId");
        if (!(await assertProgramme(programmeId))) return c.json({ error: "Programme not found" }, 404);
        const input = createDeliverableSchema.parse(await c.req.json());

        const deliverable = await prisma.deliverable.create({
          data: {
            programmeId,
            cohortId: input.cohortId ?? null,
            participantId: input.participantId ?? null,
            title: input.title,
            description: input.description ?? null,
            resourceType: (input.resourceType ?? "document") as ResourceType,
            url: input.url ?? null,
            status: (input.status ?? "pending") as DeliverableStatus,
            scheduledAt: parseDate(input.scheduledAt ?? undefined) ?? null,
            deliveredAt: parseDate(input.deliveredAt ?? undefined) ?? null,
            metadata: (input.metadata ?? {}) as Prisma.InputJsonValue
          },
          include: {
            participant: { select: { id: true, name: true, email: true } }
          }
        });

        return serializeDeliverable(deliverable);
      })
    )
    .patch("/:programmeId/deliverables/:deliverableId", (c) =>
      handleRoute(c, async () => {
        const { programmeId, deliverableId } = c.req.param();
        const input = updateDeliverableSchema.parse(await c.req.json());

        const existing = await prisma.deliverable.findFirst({
          where: { id: deliverableId, programmeId }
        });
        if (!existing) return c.json({ error: "Deliverable not found" }, 404);

        const updated = await prisma.deliverable.update({
          where: { id: deliverableId },
          data: {
            participantId: input.participantId,
            cohortId: input.cohortId,
            title: input.title,
            description: input.description,
            resourceType: input.resourceType as ResourceType | undefined,
            url: input.url,
            status: input.status as DeliverableStatus | undefined,
            scheduledAt: input.scheduledAt !== undefined ? parseDate(input.scheduledAt) : undefined,
            deliveredAt: input.deliveredAt !== undefined ? parseDate(input.deliveredAt) : undefined,
            metadata: input.metadata as Prisma.InputJsonValue | undefined
          },
          include: {
            participant: { select: { id: true, name: true, email: true } }
          }
        });

        return serializeDeliverable(updated);
      })
    )
    .delete("/:programmeId/deliverables/:deliverableId", (c) =>
      handleRoute(c, async () => {
        const { programmeId, deliverableId } = c.req.param();
        const existing = await prisma.deliverable.findFirst({
          where: { id: deliverableId, programmeId }
        });
        if (!existing) return c.json({ error: "Deliverable not found" }, 404);
        await prisma.deliverable.delete({ where: { id: deliverableId } });
        return { ok: true };
      })
    );
}
