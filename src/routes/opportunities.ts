import { Hono } from "hono";
import { z } from "zod";
import { OpportunityEventStatus, OpportunityStatus, PaymentStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { handleRoute, HttpError } from "../lib/http.js";
import {
  cancelOpportunityCron,
  getOpportunityCronJobId,
  runOpportunityEventNow,
  scheduleOpportunityCron
} from "../lib/opportunity-scheduler.js";
import { prisma } from "../lib/prisma.js";
import { idParamSchema } from "../lib/schemas.js";
import { validatePipelineStepBindings } from "../lib/email/template-variables.js";
import { ensureCohortParticipantRelations } from "../lib/cohort-links.js";
import { createStripeCustomerForParticipant } from "../lib/stripe.js";
import { serializeOrganisationSummary, serializeParticipantDirectory } from "../lib/serializers.js";
import { addNotificationForAdmins } from "../lib/notifications.js";

const opportunityInclude = {
  events: { orderBy: { scheduledAt: "asc" as const } },
  org: true,
} satisfies Prisma.OpportunityInclude;

const participantDirectoryInclude = {
  organisations: {
    include: { organisation: true },
    orderBy: [{ isPrimary: "desc" as const }, { joinedAt: "asc" as const }],
  },
  programmes: {
    include: { programme: true },
    orderBy: { createdAt: "desc" as const },
  },
} satisfies Prisma.ParticipantInclude;

const opportunityInputSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  organisationId: z.string().optional(),
  importanceScore: z.number().int().min(0).max(100).optional(),
  status: z.enum(["open", "nurturing", "converted", "archived"]).optional(),
  notes: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const convertOpportunitySchema = z.object({
  organisationId: z.string().optional(),
  programmeId: z.string().optional(),
  cohortId: z.string().optional(),
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
  opportunityIds: z.array(z.string().min(1)).min(1),
  startAt: z.string().datetime()
});

const rescheduleOpportunityEventSchema = z.object({
  scheduledAt: z.string().datetime()
});

function scheduleFromAnchor(startAt: Date, delayDays: number) {
  return new Date(startAt.getTime() + delayDays * 24 * 60 * 60 * 1000);
}

async function assertPipelineStepsReady(steps: Array<{ name: string; config: unknown }>) {
  const validation = await validatePipelineStepBindings(steps, async (templateId) =>
    prisma.emailTemplate.findUnique({
      where: { id: templateId },
      select: { metadata: true },
    }),
  );
  if (!validation.valid) {
    return validation.issues;
  }
  return null;
}

function serializeOpportunity(opportunity: {
  id: string;
  name: string;
  email: string;
  organisation?: string | null;
  organisationId?: string | null;
  importanceScore: number;
  status: string;
  notes?: string | null;
  metadata?: unknown;
  pipelineAnchorAt?: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  events?: Array<Parameters<typeof serializeOpportunityEvent>[0]>;
  org?: Parameters<typeof serializeOrganisationSummary>[0] | null;
}) {
  return {
    id: opportunity.id,
    name: opportunity.name,
    email: opportunity.email,
    organisationId: opportunity.organisationId ?? undefined,
    linkedOrganisation: opportunity.org ? serializeOrganisationSummary(opportunity.org) : undefined,
    importanceScore: opportunity.importanceScore,
    status: opportunity.status,
    notes: opportunity.notes ?? undefined,
    pipelineAnchorAt:
      opportunity.pipelineAnchorAt instanceof Date
        ? opportunity.pipelineAnchorAt.toISOString()
        : opportunity.pipelineAnchorAt ?? undefined,
    metadata: opportunity.metadata && typeof opportunity.metadata === "object" && !Array.isArray(opportunity.metadata)
      ? opportunity.metadata
      : {},
    createdAt: opportunity.createdAt instanceof Date ? opportunity.createdAt.toISOString() : opportunity.createdAt,
    updatedAt: opportunity.updatedAt instanceof Date ? opportunity.updatedAt.toISOString() : opportunity.updatedAt,
    events: opportunity.events?.map(serializeOpportunityEvent) ?? [],
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
    anchorAt: event.anchorAt?.toISOString?.() ?? event.anchorAt ?? undefined,
    offsetDays: event.offsetDays ?? undefined,
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
        include: opportunityInclude,
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
          name: input.name,
          email: input.email,
          organisationId: input.organisationId ?? null,
          importanceScore: input.importanceScore ?? 0,
          status: (input.status as OpportunityStatus | undefined) ?? OpportunityStatus.open,
          notes: input.notes,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        },
        include: opportunityInclude
      });
      return serializeOpportunity(opportunity);
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const opportunity = await prisma.opportunity.findUnique({
        where: { id },
        include: opportunityInclude,
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
          name: input.name,
          email: input.email,
          organisationId: input.organisationId === undefined ? undefined : input.organisationId || null,
          importanceScore: input.importanceScore,
          status: input.status as OpportunityStatus | undefined,
          notes: input.notes,
          metadata: input.metadata as Prisma.InputJsonValue | undefined,
        },
        include: opportunityInclude
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
      const bindingIssues = await assertPipelineStepsReady(input.steps);
      if (bindingIssues) {
        return c.json({ error: "Pipeline steps are not ready to send.", issues: bindingIssues }, 400);
      }

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
  .patch("/pipelines/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = pipelineInputSchema.parse(await c.req.json());
      const bindingIssues = await assertPipelineStepsReady(input.steps);
      if (bindingIssues) {
        return c.json({ error: "Pipeline steps are not ready to send.", issues: bindingIssues }, 400);
      }

      const existing = await prisma.opportunityPipeline.findUnique({
        where: { id },
        include: { steps: true }
      });
      if (!existing) return c.json({ error: "Pipeline not found" }, 404);

      const incomingStepIds = new Set(
        input.steps.map((step) => step.id).filter((stepId): stepId is string => Boolean(stepId))
      );
      const stepsToDelete = existing.steps.filter((step) => !incomingStepIds.has(step.id));

      if (stepsToDelete.length) {
        const events = await prisma.opportunityEvent.findMany({
          where: {
            pipelineStepId: { in: stepsToDelete.map((step) => step.id) },
            status: { in: [OpportunityEventStatus.pending, OpportunityEventStatus.scheduled] }
          }
        });
        await Promise.all(events.map((event) => cancelOpportunityCron(event.cronJobId)));
      }

      const pipeline = await prisma.$transaction(async (tx) => {
        if (stepsToDelete.length) {
          await tx.opportunityEvent.updateMany({
            where: { pipelineStepId: { in: stepsToDelete.map((step) => step.id) } },
            data: { status: OpportunityEventStatus.cancelled, cancelledAt: new Date() }
          });
          await tx.opportunityPipelineStep.deleteMany({
            where: { id: { in: stepsToDelete.map((step) => step.id) } }
          });
        }

        await tx.opportunityPipeline.update({
          where: { id },
          data: {
            name: input.name,
            flow: (input.flow ?? {}) as Prisma.InputJsonValue
          }
        });

        for (const step of input.steps) {
          const stepData = {
            name: step.name,
            type: step.type,
            delayDays: step.delayDays,
            config: step.config as Prisma.InputJsonValue
          };

          if (step.id && existing.steps.some((existingStep) => existingStep.id === step.id)) {
            await tx.opportunityPipelineStep.update({
              where: { id: step.id },
              data: stepData
            });
          } else {
            await tx.opportunityPipelineStep.create({
              data: {
                pipelineId: id,
                ...stepData
              }
            });
          }
        }

        return tx.opportunityPipeline.findUnique({
          where: { id },
          include: { steps: { orderBy: { createdAt: "asc" } } }
        });
      });

      return serializePipeline(pipeline);
    })
  )
  .delete("/pipelines/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const pipeline = await prisma.opportunityPipeline.findUnique({ where: { id } });
      if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

      const events = await prisma.opportunityEvent.findMany({
        where: {
          pipelineId: id,
          status: { in: [OpportunityEventStatus.pending, OpportunityEventStatus.scheduled] }
        }
      });
      await Promise.all(events.map((event) => cancelOpportunityCron(event.cronJobId)));

      await prisma.opportunityPipeline.delete({ where: { id } });
      return { ok: true };
    })
  )
  .post("/pipelines/:id/apply", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = applyPipelineSchema.parse(await c.req.json());
      const startAt = new Date(input.startAt);
      const opportunityIds = [...new Set(input.opportunityIds)];
      const pipeline = await prisma.opportunityPipeline.findUnique({
        where: { id },
        include: { steps: { orderBy: { createdAt: "asc" } } }
      });
      if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);
      if (!pipeline.steps.length) return c.json({ error: "Pipeline has no steps." }, 400);

      const bindingIssues = await assertPipelineStepsReady(pipeline.steps);
      if (bindingIssues) {
        return c.json({ error: "Pipeline cannot be applied until all template variables are mapped.", issues: bindingIssues }, 400);
      }

      const opportunities = await prisma.opportunity.findMany({
        where: { id: { in: opportunityIds } },
        select: { id: true, status: true }
      });

      if (opportunities.length !== opportunityIds.length) {
        return c.json({ error: "One or more opportunities were not found." }, 404);
      }

      const converted = opportunities.filter((opportunity) => opportunity.status === OpportunityStatus.converted);
      if (converted.length) {
        return c.json({ error: "Cannot apply a pipeline to converted opportunities." }, 409);
      }

      const existingEvents = await prisma.opportunityEvent.findMany({
        where: {
          opportunityId: { in: opportunityIds },
          pipelineId: pipeline.id,
          status: { in: [OpportunityEventStatus.pending, OpportunityEventStatus.scheduled] }
        }
      });
      await Promise.all(existingEvents.map((event) => cancelOpportunityCron(event.cronJobId)));

      const events = await prisma.$transaction(async (tx) => {
        if (existingEvents.length) {
          await tx.opportunityEvent.updateMany({
            where: { id: { in: existingEvents.map((event) => event.id) } },
            data: { status: OpportunityEventStatus.cancelled, cancelledAt: new Date() }
          });
        }

        await tx.opportunity.updateMany({
          where: { id: { in: opportunityIds } },
          data: { pipelineAnchorAt: startAt }
        });

        const created = [];
        for (const opportunityId of opportunityIds) {
          for (const step of pipeline.steps) {
            const cronJobId = getOpportunityCronJobId(opportunityId, step.id);
            const scheduledAt = scheduleFromAnchor(startAt, step.delayDays);
            const event = await tx.opportunityEvent.upsert({
              where: { cronJobId },
              create: {
                opportunityId,
                pipelineId: pipeline.id,
                pipelineStepId: step.id,
                name: step.name,
                type: step.type,
                scheduledAt,
                anchorAt: startAt,
                offsetDays: step.delayDays,
                status: OpportunityEventStatus.pending,
                cronJobId,
                config: step.config as any
              },
              update: {
                name: step.name,
                type: step.type,
                scheduledAt,
                anchorAt: startAt,
                offsetDays: step.delayDays,
                status: OpportunityEventStatus.pending,
                config: step.config as any,
                cancelledAt: null,
                error: null,
                completedAt: null
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
  .patch("/events/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = rescheduleOpportunityEventSchema.parse(await c.req.json());
      const scheduledAt = new Date(input.scheduledAt);

      const event = await prisma.opportunityEvent.findUnique({ where: { id } });
      if (!event) throw new HttpError("Event not found.", 404);

      if (
        event.status !== OpportunityEventStatus.pending &&
        event.status !== OpportunityEventStatus.scheduled
      ) {
        throw new HttpError("Only pending or scheduled events can be rescheduled.", 409);
      }

      await cancelOpportunityCron(event.cronJobId);
      const updated = await prisma.opportunityEvent.update({
        where: { id },
        data: { scheduledAt, status: OpportunityEventStatus.scheduled, error: null }
      });

      await scheduleOpportunityCron(updated);
      return serializeOpportunityEvent(updated);
    })
  )
  .post("/events/:id/cancel", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const event = await prisma.opportunityEvent.findUnique({ where: { id } });
      if (!event) throw new HttpError("Event not found.", 404);

      if (
        event.status !== OpportunityEventStatus.pending &&
        event.status !== OpportunityEventStatus.scheduled
      ) {
        throw new HttpError("Only pending or scheduled events can be cancelled.", 409);
      }

      await cancelOpportunityCron(event.cronJobId);
      const updated = await prisma.opportunityEvent.update({
        where: { id },
        data: { status: OpportunityEventStatus.cancelled, cancelledAt: new Date() }
      });
      return serializeOpportunityEvent(updated);
    })
  )
  .post("/events/:id/run", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const updated = await runOpportunityEventNow(id);
      if (!updated) throw new HttpError("Event not found.", 404);
      return serializeOpportunityEvent(updated);
    })
  )
  .delete("/events/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const event = await prisma.opportunityEvent.findUnique({ where: { id } });
      if (!event) throw new HttpError("Event not found.", 404);

      await cancelOpportunityCron(event.cronJobId);
      await prisma.opportunityEvent.delete({ where: { id } });
      return { ok: true };
    })
  )
  .post("/:id/convert", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = convertOpportunitySchema.parse(await c.req.json());

      const opportunity = await prisma.opportunity.findUnique({
        where: { id },
        include: opportunityInclude,
      });

      if (!opportunity) {
        return c.json({ error: "Opportunity not found." }, 404);
      }

      if (opportunity.status === OpportunityStatus.converted) {
        return c.json({ error: "This opportunity has already been converted." }, 409);
      }

      const existingParticipant = await prisma.participant.findUnique({
        where: { email: opportunity.email },
        select: { id: true },
      });

      if (existingParticipant) {
        return c.json({ error: "A participant with this email already exists." }, 409);
      }

      const organisationId = input.organisationId ?? opportunity.organisationId ?? undefined;

      const participant = await prisma.$transaction(async (tx) => {
        const stripeCustomerId = await createStripeCustomerForParticipant({
          name: opportunity.name,
          email: opportunity.email,
          phone: undefined,
        });

        const created = await tx.participant.create({
          data: {
            name: opportunity.name,
            email: opportunity.email,
            notes: opportunity.notes,
            stripeCustomerId,
            metadata: {
              convertedFromOpportunityId: opportunity.id,
            } as Prisma.InputJsonValue,
          },
        });

        if (organisationId) {
          await tx.organisationParticipant.upsert({
            where: {
              organisationId_participantId: {
                organisationId,
                participantId: created.id,
              },
            },
            create: {
              organisationId,
              participantId: created.id,
              isPrimary: true,
            },
            update: {},
          });
        }

      if (input.cohortId) {
        await ensureCohortParticipantRelations(tx, {
          cohortId: input.cohortId,
          participantId: created.id,
          programmeId: input.programmeId,
        });
      } else if (input.programmeId) {
        await tx.programmeParticipant.create({
          data: {
            programmeId: input.programmeId,
            participantId: created.id,
            paymentStatus: PaymentStatus.not_invoiced,
          },
        });
      }

        await tx.opportunity.update({
          where: { id: opportunity.id },
          data: {
            status: OpportunityStatus.converted,
            metadata: {
              ...(typeof opportunity.metadata === "object" && opportunity.metadata && !Array.isArray(opportunity.metadata)
                ? opportunity.metadata
                : {}),
              convertedParticipantId: created.id,
              convertedAt: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        });

        return tx.participant.findUniqueOrThrow({
          where: { id: created.id },
          include: participantDirectoryInclude,
        });
      });

      const pendingEvents = opportunity.events.filter(
        (event) => event.status === OpportunityEventStatus.pending || event.status === OpportunityEventStatus.scheduled,
      );

      if (pendingEvents.length) {
        await Promise.all(pendingEvents.map((event) => cancelOpportunityCron(event.cronJobId)));
        await prisma.opportunityEvent.updateMany({
          where: { id: { in: pendingEvents.map((event) => event.id) } },
          data: { status: OpportunityEventStatus.cancelled, cancelledAt: new Date() },
        });
      }

      try {
        await addNotificationForAdmins({
          type: "opportunity_converted",
          title: "Opportunity converted",
          message: `${opportunity.name} was converted into a participant.`,
          meta: { opportunityId: opportunity.id, participantId: participant.id },
        });
      } catch (err) {
        console.error("failed to add opportunity conversion notification", err);
      }

      const updatedOpportunity = await prisma.opportunity.findUniqueOrThrow({
        where: { id: opportunity.id },
        include: opportunityInclude,
      });

      return {
        participant: serializeParticipantDirectory(participant),
        opportunity: serializeOpportunity(updatedOpportunity),
      };
    }),
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
