import { Hono } from "hono";
import { EventBaseType, EventStatus, Prisma } from "../generated/client.js";
import { enrollParticipant } from "../lib/enrollment.js";
import { handleRoute } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { EVENT_SCHEDULE_HASH } from "../jobs/utils.js";
import { addNotificationForAdmins } from "../lib/notifications.js";
import {
  serializeBaseParticipant,
  serializeCohort,
  serializeCohortProgramme,
  serializeRegistrationPage
} from "../lib/serializers.js";
import {
  addCohortParticipantSchema,
  cohortQuerySchema,
  createCohortSchema,
  createRegistrationPageSchema,
  idParamSchema,
  linkCohortProgrammeSchema,
  registrationPageParamSchema,
  saveCohortEventFlowSchema,
  saveCohortEventFlowStateSchema,
  updateCohortSchema,
  updateRegistrationPageSchema
} from "../lib/schemas.js";
import { uniqueSlug } from "../lib/slug.js";

const cohortDetailInclude = {
  organisation: true,
  programmes: {
    include: { programme: true },
    orderBy: { enrolledAt: "desc" as const }
  },
  participants: {
    include: { participant: true },
    orderBy: { joinedAt: "desc" as const }
  },
  registrationPages: {
    orderBy: { createdAt: "desc" as const }
  },
  eventFlows: {
    include: {
      events: { orderBy: { scheduledAt: "asc" as const } }
    }
  },
  _count: {
    select: { participants: true, programmes: true, registrationPages: true }
  }
} satisfies Prisma.CohortInclude;

export const cohortsRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const { organisationId } = cohortQuerySchema.parse(c.req.query());
      const cohorts = await prisma.cohort.findMany({
        where: organisationId ? { organisationId } : undefined,
        orderBy: { createdAt: "desc" },
        include: {
          organisation: true,
          _count: {
            select: { participants: true, programmes: true, registrationPages: true }
          }
        }
      });

      return cohorts.map(serializeCohort);
    })
  )
  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = createCohortSchema.parse(await c.req.json());
      const slug =
        input.slug ??
        (await uniqueSlug(input.name, async (candidate) => {
          const existing = await prisma.cohort.findUnique({ where: { slug: candidate } });
          return Boolean(existing);
        }, "cohort"));

      const cohort = await prisma.cohort.create({
        data: {
          name: input.name,
          slug,
          type: input.type,
          status: input.status,
          organisationId: input.organisationId ?? null,
          logoUrl: input.logoUrl ?? null,
          description: input.description ?? null,
          maxSize: input.maxSize ?? null,
          startDate: input.startDate ? new Date(input.startDate) : null,
          endDate: input.endDate ? new Date(input.endDate) : null,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
          eventFlows: {
            create: {
              flow: {},
              deployedAt: null
            }
          },
          commsChannel: {
            create: {}
          }
        },
        include: cohortDetailInclude
      });

      return serializeCohort(cohort);
    })
  )
  .patch("/registration-pages/:pageId", (c) =>
    handleRoute(c, async () => {
      const { pageId } = registrationPageParamSchema.parse(c.req.param());
      const input = updateRegistrationPageSchema.parse(await c.req.json());

      let slug = input.slug;
      if (input.slug) {
        const taken = await prisma.registrationPage.findFirst({
          where: { slug: input.slug, NOT: { id: pageId } }
        });
        if (taken) throw new Error("Slug is already in use.");
      }

      const page = await prisma.registrationPage.update({
        where: { id: pageId },
        data: {
          slug,
          title: input.title,
          logoUrl: input.logoUrl,
          steps: input.steps as Prisma.InputJsonValue | undefined,
          isPublished: input.isPublished,
          expiresAt: input.expiresAt === undefined ? undefined : input.expiresAt ? new Date(input.expiresAt) : null,
          metadata: input.metadata as Prisma.InputJsonValue | undefined
        }
      });

      return serializeRegistrationPage(page);
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const cohort = await prisma.cohort.findUnique({
        where: { id },
        include: cohortDetailInclude
      });

      return cohort ? serializeCohort(cohort) : null;
    })
  )
  .patch("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateCohortSchema.parse(await c.req.json());

      let slug = input.slug;
      if (input.slug) {
        const taken = await prisma.cohort.findFirst({
          where: { slug: input.slug, NOT: { id } }
        });
        if (taken) throw new Error("Slug is already in use.");
      }

      const cohort = await prisma.cohort.update({
        where: { id },
        data: {
          name: input.name,
          slug,
          type: input.type,
          status: input.status,
          organisationId: input.organisationId,
          logoUrl: input.logoUrl,
          description: input.description,
          maxSize: input.maxSize,
          startDate: input.startDate === undefined ? undefined : input.startDate ? new Date(input.startDate) : null,
          endDate: input.endDate === undefined ? undefined : input.endDate ? new Date(input.endDate) : null,
          metadata: input.metadata as Prisma.InputJsonValue | undefined
        },
        include: cohortDetailInclude
      });

      return serializeCohort(cohort);
    })
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.cohort.delete({ where: { id } });
      return { ok: true };
    })
  )
  .post("/:id/programmes", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = linkCohortProgrammeSchema.parse(await c.req.json());

      const link = await prisma.cohortProgramme.upsert({
        where: {
          cohortId_programmeId: {
            cohortId: id,
            programmeId: input.programmeId
          }
        },
        create: {
          cohortId: id,
          programmeId: input.programmeId
        },
        update: {},
        include: { programme: true }
      });

      return serializeCohortProgramme(link);
    })
  )
  .delete("/:id/programmes/:programmeId", (c) =>
    handleRoute(c, async () => {
      const { id, programmeId } = c.req.param();
      await prisma.cohortProgramme.delete({
        where: {
          cohortId_programmeId: {
            cohortId: id,
            programmeId
          }
        }
      });
      return { ok: true };
    })
  )
  .post("/:id/participants", (c) =>
    handleRoute(c, async () => {
      const { id: cohortId } = idParamSchema.parse(c.req.param());
      const input = addCohortParticipantSchema.parse(await c.req.json());
      const cohort = await prisma.cohort.findUniqueOrThrow({
        where: { id: cohortId },
        select: { organisationId: true }
      });

      if (input.participantId) {
        const participant = await prisma.participant.findUniqueOrThrow({
          where: { id: input.participantId }
        });

        const cohortParticipant = await prisma.cohortParticipant.upsert({
          where: {
            cohortId_participantId: {
              cohortId,
              participantId: participant.id
            }
          },
          create: {
            cohortId,
            participantId: participant.id
          },
          update: {},
          include: { participant: true }
        });

        if (cohort.organisationId) {
          await prisma.organisationParticipant.upsert({
            where: {
              organisationId_participantId: {
                organisationId: cohort.organisationId,
                participantId: participant.id
              }
            },
            create: {
              organisationId: cohort.organisationId,
              participantId: participant.id
            },
            update: {}
          });
        }

        return {
          id: cohortParticipant.id,
          cohortId: cohortParticipant.cohortId,
          participantId: cohortParticipant.participantId,
          joinedAt: cohortParticipant.joinedAt.toISOString(),
          participant: serializeBaseParticipant(cohortParticipant.participant)
        };
      }

      const result = await enrollParticipant({
        programmeId: input.programmeId!,
        cohortId,
        name: input.name!,
        email: input.email!,
        organisation: input.organisation,
        phone: input.phone,
        address: input.address,
        notes: input.notes,
        metadata: input.metadata,
        organisationId: cohort.organisationId ?? undefined
      });

      return {
        participant: serializeBaseParticipant(result.participant),
        programmeParticipant: {
          id: result.programmeParticipant.id,
          programmeId: result.programmeParticipant.programmeId,
          participantId: result.programmeParticipant.participantId,
          cohortId: result.programmeParticipant.cohortId ?? undefined
        },
        cohortParticipant: result.cohortParticipant
          ? {
              id: result.cohortParticipant.id,
              cohortId: result.cohortParticipant.cohortId,
              participantId: result.cohortParticipant.participantId,
              joinedAt: result.cohortParticipant.joinedAt.toISOString()
            }
          : undefined
      };
    })
  )
  .get("/:id/participants", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const participants = await prisma.cohortParticipant.findMany({
        where: { cohortId: id },
        include: { participant: true },
        orderBy: { joinedAt: "desc" }
      });

      return participants.map((entry) => ({
        id: entry.id,
        cohortId: entry.cohortId,
        participantId: entry.participantId,
        joinedAt: entry.joinedAt.toISOString(),
        metadata: entry.metadata,
        participant: serializeBaseParticipant(entry.participant)
      }));
    })
  )
  .get("/:id/event-flow", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const eventFlow = await prisma.cohortEventFlow.findUnique({
        where: { cohortId: id }
      });

      if (!eventFlow) return null;

      return {
        id: eventFlow.id,
        cohortId: eventFlow.cohortId,
        flow: eventFlow.flow,
        deployedAt: eventFlow.deployedAt?.toISOString() ?? null,
        createdAt: eventFlow.createdAt.toISOString(),
        updatedAt: eventFlow.updatedAt.toISOString()
      };
    })
  )
  .patch("/:id/event-flow", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = saveCohortEventFlowSchema.parse(await c.req.json());

      const eventFlow = await prisma.cohortEventFlow.upsert({
        where: { cohortId: id },
        create: {
          cohortId: id,
          flow: input.flow,
          deployedAt: input.deployedAt ? new Date(input.deployedAt) : null
        },
        update: {
          flow: input.flow,
          deployedAt: input.deployedAt === undefined ? undefined : input.deployedAt ? new Date(input.deployedAt) : null
        }
      });

      return {
        id: eventFlow.id,
        cohortId: eventFlow.cohortId,
        flow: eventFlow.flow,
        deployedAt: eventFlow.deployedAt?.toISOString() ?? null,
        createdAt: eventFlow.createdAt.toISOString(),
        updatedAt: eventFlow.updatedAt.toISOString()
      };
    })
  )
  .put("/:id/event-flow-state", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = saveCohortEventFlowStateSchema.parse(await c.req.json());

      const cohort = await prisma.cohort.findUniqueOrThrow({
        where: { id },
        include: {
          programmes: { orderBy: { enrolledAt: "asc" }, take: 1 }
        }
      });

      const programmeId = input.programmeId ?? cohort.programmes[0]?.programmeId;
      if (!programmeId) {
        throw new Error("Cohort must be linked to a programme before saving event flow state");
      }

      const retainedEventIds = input.events.map((event) => event.id ?? crypto.randomUUID());
      const eventsWithIds = input.events.map((event, index) => ({
        ...event,
        id: retainedEventIds[index]
      }));

      await prisma.event.deleteMany({
        where: {
          cohortId: id,
          id: { notIn: retainedEventIds }
        }
      });

      const remappedFlow = Object.fromEntries(
        Object.entries(input.eventFlow)
          .filter(([eventId, dependencyId]) => retainedEventIds.includes(eventId) && retainedEventIds.includes(dependencyId))
          .sort(([a], [b]) => a.localeCompare(b))
      );

      const cohortEventFlow = await prisma.cohortEventFlow.upsert({
        where: { cohortId: id },
        create: {
          cohortId: id,
          flow: remappedFlow,
          deployedAt: null
        },
        update: {
          flow: remappedFlow,
          deployedAt: null
        }
      });

      const cohortEventFlowId = cohortEventFlow.id;

      if (eventsWithIds.length > 0) {
        await prisma.$executeRaw`
          INSERT INTO "Event" ("id", "name", "programmeId", "cohortEventFlowId", "cohortId", "baseType", "scheduledAt", "status", "config")
          VALUES ${Prisma.join(
            eventsWithIds.map((event) => Prisma.sql`(
              ${event.id},
              ${event.name},
              ${programmeId},
              ${cohortEventFlowId},
              ${id},
              ${(event.baseType as EventBaseType)}::"EventBaseType",
              ${new Date(event.scheduledAt)},
              ${(event.status ?? "pending") as EventStatus}::"EventStatus",
              ${JSON.stringify(event.config ?? {})}::jsonb
            )`)
          )}
          ON CONFLICT ("id") DO UPDATE SET
            "name" = EXCLUDED."name",
            "programmeId" = EXCLUDED."programmeId",
            "cohortEventFlowId" = EXCLUDED."cohortEventFlowId",
            "cohortId" = EXCLUDED."cohortId",
            "baseType" = EXCLUDED."baseType",
            "scheduledAt" = EXCLUDED."scheduledAt",
            "status" = EXCLUDED."status",
            "config" = EXCLUDED."config"
        `;
      }

      const updatedCohort = await prisma.cohort.findUnique({
        where: { id },
        include: cohortDetailInclude
      });

      return updatedCohort ? serializeCohort(updatedCohort) : null;
    })
  )
  .post("/:id/deploy-events", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const events = await prisma.event.findMany({
        where: {
          cohortId: id,
          cohortEventFlow: { cohortId: id },
          status: "pending"
        },
        select: { id: true, scheduledAt: true }
      });

      if (events.length > 0) {
        await redis.hset(
          EVENT_SCHEDULE_HASH,
          Object.fromEntries(events.map((event) => [event.id, event.scheduledAt.toISOString()]))
        );
      }

      await prisma.cohortEventFlow.upsert({
        where: { cohortId: id },
        create: {
          cohortId: id,
          flow: {},
          deployedAt: new Date()
        },
        update: {
          deployedAt: new Date()
        }
      });

      try {
        await addNotificationForAdmins({
          type: "event_deployed",
          title: "Cohort event flow deployed",
          message: `Deployed ${events.length} pending events for cohort ${id}`,
          meta: { cohortId: id, scheduled: events.length }
        });
      } catch (err) {
        console.error("failed to add deploy notification", err);
      }

      return { ok: true, scheduled: events.length };
    })
  )
  .post("/:id/registration-pages", (c) =>
    handleRoute(c, async () => {
      const { id: cohortId } = idParamSchema.parse(c.req.param());
      const input = createRegistrationPageSchema.parse(await c.req.json());
      const slug =
        input.slug ??
        (await uniqueSlug(input.title ?? `cohort-${cohortId}`, async (candidate) => {
          const existing = await prisma.registrationPage.findUnique({ where: { slug: candidate } });
          return Boolean(existing);
        }, "register"));

      const page = await prisma.registrationPage.create({
        data: {
          cohortId,
          slug,
          title: input.title ?? null,
          logoUrl: input.logoUrl ?? null,
          steps: (input.steps ?? []) as Prisma.InputJsonValue,
          isPublished: input.isPublished ?? false,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue
        }
      });

      return serializeRegistrationPage(page);
    })
  )
  .get("/:id/registration-pages", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const pages = await prisma.registrationPage.findMany({
        where: { cohortId: id },
        orderBy: { createdAt: "desc" }
      });

      return pages.map(serializeRegistrationPage);
    })
  );
