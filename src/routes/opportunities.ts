import { Hono } from "hono";
import { z } from "zod";
import { OpportunityEventStatus, OpportunityStatus } from "../generated/client";
import { handleRoute } from "../lib/http";
import {
  cancelOpportunityCron,
  getOpportunityCronJobId,
  scheduleOpportunityCron
} from "../lib/opportunity-scheduler";
import { prisma } from "../lib/prisma";
import { idParamSchema } from "../lib/schemas";

const opportunityInputSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  organisation: z.string().optional(),
  importanceScore: z.number().int().min(0).max(100).optional(),
  status: z.enum(["open", "nurturing", "converted", "archived"]).optional(),
  notes: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const pipelineStepSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  type: z.string().default("send_email"),
  delayDays: z.number().int().min(0).default(0),
  config: z.record(z.string(), z.unknown()).default({})
});

const pipelineInputSchema = z.object({
  name: z.string().min(1),
  flow: z.record(z.string(), z.string()).optional(),
  steps: z.array(pipelineStepSchema).min(1)
});

const applyPipelineSchema = z.object({
  opportunityIds: z.array(z.string().min(1)).min(1)
});

function serializeOpportunity(opportunity: any) {
  return {
    ...opportunity,
    createdAt: opportunity.createdAt?.toISOString?.() ?? opportunity.createdAt,
    updatedAt: opportunity.updatedAt?.toISOString?.() ?? opportunity.updatedAt,
    events: opportunity.events?.map(serializeOpportunityEvent) ?? []
  };
}

function serializePipeline(pipeline: any) {
  return {
    ...pipeline,
    createdAt: pipeline.createdAt?.toISOString?.() ?? pipeline.createdAt,
    updatedAt: pipeline.updatedAt?.toISOString?.() ?? pipeline.updatedAt,
    steps: pipeline.steps?.map((step: any) => ({
      ...step,
      createdAt: step.createdAt?.toISOString?.() ?? step.createdAt,
      updatedAt: step.updatedAt?.toISOString?.() ?? step.updatedAt
    })) ?? []
  };
}

function serializeOpportunityEvent(event: any) {
  return {
    ...event,
    scheduledAt: event.scheduledAt?.toISOString?.() ?? event.scheduledAt,
    completedAt: event.completedAt?.toISOString?.() ?? event.completedAt,
    cancelledAt: event.cancelledAt?.toISOString?.() ?? event.cancelledAt,
    createdAt: event.createdAt?.toISOString?.() ?? event.createdAt,
    updatedAt: event.updatedAt?.toISOString?.() ?? event.updatedAt
  };
}

export const opportunitiesRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const opportunities = await prisma.opportunity.findMany({
        include: { events: { orderBy: { scheduledAt: "asc" } } },
        orderBy: { createdAt: "desc" }
      });
      return opportunities.map(serializeOpportunity);
    })
  )
  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = opportunityInputSchema.parse(await c.req.json());
      const opportunity = await prisma.opportunity.create({
        data: {
          ...input,
          status: input.status as OpportunityStatus | undefined,
          metadata: (input.metadata ?? {}) as any
        },
        include: { events: true }
      });
      return serializeOpportunity(opportunity);
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const opportunity = await prisma.opportunity.findUnique({
        where: { id },
        include: { events: { orderBy: { scheduledAt: "asc" } } }
      });
      return opportunity ? serializeOpportunity(opportunity) : null;
    })
  )
  .patch("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = opportunityInputSchema.partial().parse(await c.req.json());
      const opportunity = await prisma.opportunity.update({
        where: { id },
        data: {
          ...input,
          status: input.status as OpportunityStatus | undefined,
          metadata: input.metadata as any
        },
        include: { events: { orderBy: { scheduledAt: "asc" } } }
      });
      return serializeOpportunity(opportunity);
    })
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const events = await prisma.opportunityEvent.findMany({ where: { opportunityId: id } });
      await Promise.all(events.map((event) => cancelOpportunityCron(event.cronJobId)));
      await prisma.opportunity.delete({ where: { id } });
      return { ok: true };
    })
  )
  .get("/pipelines/list", (c) =>
    handleRoute(c, async () => {
      const pipelines = await prisma.opportunityPipeline.findMany({
        include: { steps: { orderBy: { createdAt: "asc" } } },
        orderBy: { updatedAt: "desc" }
      });
      return pipelines.map(serializePipeline);
    })
  )
  .post("/pipelines", (c) =>
    handleRoute(c, async () => {
      const input = pipelineInputSchema.parse(await c.req.json());
      const pipeline = await prisma.$transaction(async (tx) => {
        const record = await tx.opportunityPipeline.create({
          data: {
            name: input.name,
            flow: input.flow ?? {},
            steps: {
              create: input.steps.map((step) => ({
                name: step.name,
                type: step.type,
                delayDays: step.delayDays,
                config: step.config as any
              }))
            }
          },
          include: { steps: { orderBy: { createdAt: "asc" } } }
        });
        return record;
      });
      return serializePipeline(pipeline);
    })
  )
  .post("/pipelines/:id/apply", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = applyPipelineSchema.parse(await c.req.json());
      const opportunityIds = [...new Set(input.opportunityIds)];
      const pipeline = await prisma.opportunityPipeline.findUnique({
        where: { id },
        include: { steps: true }
      });
      if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

      const events = await prisma.$transaction(async (tx) => {
        const created = [];
        for (const opportunityId of opportunityIds) {
          for (const step of pipeline.steps) {
            const cronJobId = getOpportunityCronJobId(opportunityId, step.id);
            const scheduledAt = new Date(Date.now() + step.delayDays * 24 * 60 * 60 * 1000);
            const event = await tx.opportunityEvent.upsert({
              where: { cronJobId },
              create: {
                opportunityId,
                pipelineId: pipeline.id,
                pipelineStepId: step.id,
                name: step.name,
                type: step.type,
                scheduledAt,
                status: OpportunityEventStatus.pending,
                cronJobId,
                config: step.config as any
              },
              update: {
                name: step.name,
                type: step.type,
                scheduledAt,
                status: OpportunityEventStatus.pending,
                config: step.config as any,
                cancelledAt: null,
                error: null
              }
            });
            created.push(event);
          }
        }
        return created;
      });

      for (const event of events) {
        await scheduleOpportunityCron(event);
        await prisma.opportunityEvent.update({
          where: { id: event.id },
          data: { status: OpportunityEventStatus.scheduled }
        });
      }

      return events.map(serializeOpportunityEvent);
    })
  )
  .delete("/pipeline-steps/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const events = await prisma.opportunityEvent.findMany({ where: { pipelineStepId: id } });
      await Promise.all(events.map((event) => cancelOpportunityCron(event.cronJobId)));
      await prisma.$transaction([
        prisma.opportunityEvent.updateMany({
          where: { pipelineStepId: id },
          data: { status: OpportunityEventStatus.cancelled, cancelledAt: new Date() }
        }),
        prisma.opportunityPipelineStep.delete({ where: { id } })
      ]);
      return { ok: true };
    })
  )
  .delete("/events/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const event = await prisma.opportunityEvent.findUnique({ where: { id } });
      if (!event) return c.json({ error: "Event not found" }, 404);
      await cancelOpportunityCron(event.cronJobId);
      const updated = await prisma.opportunityEvent.update({
        where: { id },
        data: { status: OpportunityEventStatus.cancelled, cancelledAt: new Date() }
      });
      return serializeOpportunityEvent(updated);
    })
  )
  .post("/:id/cancel-events", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const events = await prisma.opportunityEvent.findMany({
        where: { opportunityId: id, status: { in: [OpportunityEventStatus.pending, OpportunityEventStatus.scheduled] } }
      });
      await Promise.all(events.map((event) => cancelOpportunityCron(event.cronJobId)));
      await prisma.opportunityEvent.updateMany({
        where: { id: { in: events.map((event) => event.id) } },
        data: { status: OpportunityEventStatus.cancelled, cancelledAt: new Date() }
      });
      return { ok: true, cancelled: events.length };
    })
  );
