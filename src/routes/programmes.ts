import { Hono } from "hono";
import { EventBaseType, EventStatus, Prisma } from "../generated/client";
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { handleRoute } from "../lib/http";
import { serializeProgramme } from "../lib/serializers";
import { EVENT_SCHEDULE_HASH } from "../jobs/utils";
import { addNotificationForAdmins } from "../lib/notifications";
import {
  createProgrammeSchema,
  eventFlowSchema,
  idParamSchema,
  participantDefinitionSchema,
  saveProgrammeEventFlowStateSchema,
  updateProgrammeSchema
} from "../lib/schemas";

const defaultParticipantDefinition = {
  fields: []
};

export const programmesRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const programmes = await prisma.programme.findMany({
        orderBy: { startDate: "desc" }
      });
      return programmes.map(serializeProgramme);
    })
  )
  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = createProgrammeSchema.parse(await c.req.json());
      const programme = await prisma.programme.create({
        data: {
          name: input.name,
          description: input.description ?? null,
          costPerParticipant: input.costPerParticipant ?? null,
          startDate: new Date(input.startDate),
          participantDefinition: input.participantDefinition ?? defaultParticipantDefinition,
          eventFlow: {
            create: {
              flow: input.eventFlow ?? {},
              deployedAt: null
            }
          }
        },
        include: {
          eventFlow: true
        }
      });
      return serializeProgramme(programme);
    })
  )
  .get("/:programmeId/events/:eventId/status", (c) =>
    handleRoute(c, async () => {
      const { programmeId, eventId } = c.req.param();
      const event = await prisma.event.findFirst({
        where: { id: eventId, programmeId },
        select: { id: true, name: true, status: true, scheduledAt: true, baseType: true }
      });

      if (!event) return null;

      const programmeParticipants = await prisma.programmeParticipant.findMany({
        where: { programmeId },
        include: {
          participant: true
        },
        orderBy: { createdAt: "asc" }
      });

      const statuses = await prisma.eventParticipantStatus.findMany({
        where: {
          eventId,
          participantId: { in: programmeParticipants.map((entry) => entry.participantId) }
        }
      });
      const statusByParticipantId = new Map(statuses.map((status) => [status.participantId, status]));

      const participants = programmeParticipants.map((entry) => {
        const status = statusByParticipantId.get(entry.participantId);
        const metadata =
          typeof status?.metadata === "object" && status.metadata !== null && !Array.isArray(status.metadata)
            ? status.metadata
            : {};
        return {
          participantId: entry.participantId,
          name: entry.participant.name,
          email: entry.participant.email,
          status: status?.status ?? "not_sent",
          metadata
        };
      });

      const sent = participants.filter((participant) => participant.status === "sent" || participant.status === "completed").length;
      const failed = participants.filter((participant) => "error" in participant.metadata).length;
      const pending = participants.length - sent - failed;

      return {
        event: {
          ...event,
          scheduledAt: event.scheduledAt.toISOString()
        },
        participants,
        summary: {
          total: participants.length,
          sent,
          failed,
          pending
        }
      };
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const programme = await prisma.programme.findUnique({
        where: { id },
        include: {
          eventFlow: true,
          events: { orderBy: { scheduledAt: "asc" } },
          formTables: true,
          participantInvoices: true,
          emailTemplates: true
        }
      });
      return programme ? serializeProgramme(programme) : null;
    })
  )
  .patch("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateProgrammeSchema.parse(await c.req.json());
      const programme = await prisma.programme.update({
        where: { id },
        data: {
          name: input.name,
          description: input.description,
          costPerParticipant: input.costPerParticipant,
          startDate: input.startDate ? new Date(input.startDate) : undefined,
          participantDefinition: input.participantDefinition,
          eventFlow: input.eventFlow
            ? {
                upsert: {
                  create: {
                    flow: input.eventFlow,
                    deployedAt: null
                  },
                  update: {
                    flow: input.eventFlow
                  }
                }
              }
            : undefined
        },
        include: {
          eventFlow: true
        }
      });
      return serializeProgramme(programme);
    })
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.programme.delete({ where: { id } });
      return { ok: true };
    })
  )
  .put("/:id/event-flow", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const eventFlow = eventFlowSchema.parse(await c.req.json());
      const programme = await prisma.programme.update({
        where: { id },
        data: {
          eventFlow: {
            upsert: {
              create: {
                flow: eventFlow,
                deployedAt: null
              },
              update: {
                flow: eventFlow,
                deployedAt: null
              }
            }
          }
        },
        include: {
          eventFlow: true
        }
      });
      return serializeProgramme(programme);
    })
  )
  .put("/:id/event-flow-state", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = saveProgrammeEventFlowStateSchema.parse(await c.req.json());
      const retainedEventIds = input.events.map((event) => event.id ?? crypto.randomUUID());
      const eventsWithIds = input.events.map((event, index) => ({
        ...event,
        id: retainedEventIds[index]
      }));

      await prisma.event.deleteMany({
        where: {
          programmeId: id,
          id: { notIn: retainedEventIds }
        }
      });

      const remappedFlow = Object.fromEntries(
        Object.entries(input.eventFlow)
          .filter(([eventId, dependencyId]) => retainedEventIds.includes(eventId) && retainedEventIds.includes(dependencyId))
          .sort(([a], [b]) => a.localeCompare(b))
      );

      const flowProgramme = await prisma.programme.update({
        where: { id },
        data: {
          eventFlow: {
            upsert: {
              create: {
                flow: remappedFlow,
                deployedAt: null
              },
              update: {
                flow: remappedFlow,
                deployedAt: null
              }
            }
          }
        },
        include: {
          eventFlow: true
        }
      });

      const eventFlowId = flowProgramme.eventFlow?.id ?? null;

      if (eventsWithIds.length > 0) {
        await prisma.$executeRaw`
          INSERT INTO "Event" ("id", "name", "programmeId", "eventFlowId", "baseType", "scheduledAt", "status", "config")
          VALUES ${Prisma.join(
            eventsWithIds.map((event) => Prisma.sql`(
              ${event.id},
              ${event.name},
              ${id},
              ${eventFlowId},
              ${(event.baseType as EventBaseType)}::"EventBaseType",
              ${new Date(event.scheduledAt)},
              ${(event.status ?? "pending") as EventStatus}::"EventStatus",
              ${JSON.stringify(event.config ?? {})}::jsonb
            )`)
          )}
          ON CONFLICT ("id") DO UPDATE SET
            "name" = EXCLUDED."name",
            "programmeId" = EXCLUDED."programmeId",
            "eventFlowId" = EXCLUDED."eventFlowId",
            "baseType" = EXCLUDED."baseType",
            "scheduledAt" = EXCLUDED."scheduledAt",
            "status" = EXCLUDED."status",
            "config" = EXCLUDED."config"
        `;
      }

      const programme = await prisma.programme.findUnique({
        where: { id },
        include: {
          eventFlow: true,
          events: { orderBy: { scheduledAt: "asc" } }
        }
      });

      return serializeProgramme(programme ?? flowProgramme);
    })
  )
  .post("/:id/deploy", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const events = await prisma.event.findMany({
        where: { programmeId: id, status: "pending" },
        select: { id: true, scheduledAt: true }
      });

      if (events.length > 0) {
        await redis.hset(
          EVENT_SCHEDULE_HASH,
          Object.fromEntries(events.map((event) => [event.id, event.scheduledAt.toISOString()]))
        );
      }

      await prisma.programme.update({
        where: { id },
        data: {
          eventFlow: {
            upsert: {
              create: {
                flow: {},
                deployedAt: new Date()
              },
              update: {
                deployedAt: new Date()
              }
            }
          }
        }
      });

      try {
        await addNotificationForAdmins({
          type: "event_deployed",
          title: "Event flow deployed",
          message: `Deployed ${events.length} pending events for programme ${id}`,
          meta: { programmeId: id, scheduled: events.length }
        });
      } catch (err) {
        console.error("failed to add deploy notification", err);
      }

      return { ok: true, scheduled: events.length };
    })
  )
  .put("/:id/participant-definition", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const participantDefinition = participantDefinitionSchema.parse(await c.req.json());
      const programme = await prisma.programme.update({
        where: { id },
        data: { participantDefinition }
      });
      return serializeProgramme(programme);
    })
  );
