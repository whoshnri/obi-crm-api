import { Hono } from "hono";
import { EventBaseType, EventStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { handleRoute } from "../lib/http.js";
import { serializeFormSubmission, serializeProgramme } from "../lib/serializers.js";
import { cancelEventCron, findDeployableEvents, resetFailedEventsForDeploy, scheduleDeployedEvents, scheduleOnFlowSave } from "../lib/event-scheduler.js";
import { addNotificationForAdmins } from "../lib/notifications.js";
import {
  createProgrammeSchema,
  eventFlowSchema,
  idParamSchema,
  programmeSubmissionsQuerySchema,
  saveProgrammeEventFlowStateSchema,
  updateProgrammeSchema
} from "../lib/schemas.js";
import { registerProgrammeDeliveryRoutes } from "./programme-delivery.js";

const programmesApp = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const programmes = await prisma.programme.findMany({
        orderBy: { startDate: "desc" },
        include: {
          eventFlow: {
            include: {
              events: { orderBy: { scheduledAt: "asc" } }
            }
          },
          participants: true
        }
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
          registrationResourceId: input.registrationResourceId ?? null,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
          adminAssignments: {
            create: {
              adminId: input.ownerAdminId
            }
          },
          eventFlow: {
            create: {
              flow: input.eventFlow ?? {},
              deployedAt: null
            }
          },
          commsChannel: {
            create: {}
          }
        },
        include: {
          eventFlow: {
            include: {
              events: { orderBy: { scheduledAt: "asc" } }
            }
          },
          participants: true
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
  .get("/:programmeId/submissions", (c) =>
    handleRoute(c, async () => {
      const { programmeId } = c.req.param();
      const query = programmeSubmissionsQuerySchema.parse(c.req.query());

      const programme = await prisma.programme.findUnique({
        where: { id: programmeId },
        select: { id: true }
      });
      if (!programme) {
        return c.json({ error: "Programme not found" }, 404);
      }

      const createdAtFilter =
        query.from || query.to
          ? {
              ...(query.from
                ? {
                    gte: query.from.includes("T")
                      ? new Date(query.from)
                      : new Date(`${query.from}T00:00:00.000Z`)
                  }
                : {}),
              ...(query.to
                ? {
                    lte: query.to.includes("T")
                      ? new Date(query.to)
                      : new Date(`${query.to}T23:59:59.999Z`)
                  }
                : {})
            }
          : undefined;

      const where: Prisma.FormSubmissionWhereInput = {
        form: { programmeId },
        ...(query.formId ? { formId: query.formId } : {}),
        ...(query.cohortId ? { cohortId: query.cohortId } : {}),
        ...(query.respondentId ? { respondentId: query.respondentId } : {}),
        ...(createdAtFilter ? { createdAt: createdAtFilter } : {})
      };

      const skip = (query.page - 1) * query.limit;
      const [total, submissions] = await prisma.$transaction([
        prisma.formSubmission.count({ where }),
        prisma.formSubmission.findMany({
          where,
          include: {
            participant: {
              select: {
                id: true,
                name: true,
                email: true
              }
            },
            form: {
              select: {
                name: true
              }
            }
          },
          orderBy: { createdAt: "desc" },
          skip,
          take: query.limit
        })
      ]);

      return {
        items: submissions.map(serializeFormSubmission),
        total,
        page: query.page,
        limit: query.limit
      };
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const programme = await prisma.programme.findUnique({
        where: { id },
        include: {
          eventFlow: {
            include: {
              events: { orderBy: { scheduledAt: "asc" } }
            }
          },
          participants: true,
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
      if (input.ownerAdminId) {
        await prisma.adminProgrammeAssignment.upsert({
          where: {
            adminId_programmeId: {
              adminId: input.ownerAdminId,
              programmeId: id
            }
          },
          create: {
            adminId: input.ownerAdminId,
            programmeId: id
          },
          update: {}
        });
      }
      const programme = await prisma.programme.update({
        where: { id },
        data: {
          name: input.name,
          description: input.description,
          costPerParticipant: input.costPerParticipant,
          startDate: input.startDate ? new Date(input.startDate) : undefined,
          registrationResourceId:
            input.registrationResourceId === undefined ? undefined : input.registrationResourceId ?? null,
          metadata: input.metadata as Prisma.InputJsonValue | undefined,
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
          eventFlow: {
            include: {
              events: { orderBy: { scheduledAt: "asc" } }
            }
          },
          participants: true
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
          eventFlow: {
            include: {
              events: { orderBy: { scheduledAt: "asc" } }
            }
          },
          participants: true
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

      const eventsBeingRemoved = await prisma.event.findMany({
        where: {
          programmeId: id,
          id: { notIn: retainedEventIds },
        },
        select: { id: true },
      });
      const retainedEventsToReschedule = await prisma.event.findMany({
        where: {
          programmeId: id,
          id: { in: retainedEventIds },
          status: { not: EventStatus.completed },
        },
        select: { id: true },
      });
      const cronIdsToCancel = [
        ...new Set([
          ...retainedEventsToReschedule.map((event) => event.id),
          ...eventsBeingRemoved.map((event) => event.id),
        ]),
      ];
      await Promise.all(cronIdsToCancel.map((eventId) => cancelEventCron(eventId)));

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
                deployedAt: new Date(),
              },
              update: {
                flow: remappedFlow,
                deployedAt: new Date(),
              },
            },
          },
        },
        include: {
          eventFlow: {
            include: {
              events: { orderBy: { scheduledAt: "asc" } }
            }
          },
          participants: true
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
              ${EventStatus.pending}::"EventStatus",
              ${JSON.stringify(event.config ?? {})}::jsonb
            )`)
          )}
          ON CONFLICT ("id") DO UPDATE SET
            "name" = EXCLUDED."name",
            "programmeId" = EXCLUDED."programmeId",
            "eventFlowId" = EXCLUDED."eventFlowId",
            "baseType" = EXCLUDED."baseType",
            "scheduledAt" = EXCLUDED."scheduledAt",
            "status" = CASE
              WHEN "Event"."status" = ${EventStatus.completed}::"EventStatus" THEN "Event"."status"
              ELSE ${EventStatus.pending}::"EventStatus"
            END,
            "attemptCount" = CASE
              WHEN "Event"."status" = ${EventStatus.completed}::"EventStatus" THEN "Event"."attemptCount"
              ELSE 0
            END,
            "lastAttemptAt" = CASE
              WHEN "Event"."status" = ${EventStatus.completed}::"EventStatus" THEN "Event"."lastAttemptAt"
              ELSE NULL
            END,
            "executionMetadata" = CASE
              WHEN "Event"."status" = ${EventStatus.completed}::"EventStatus" THEN "Event"."executionMetadata"
              ELSE '{}'::jsonb
            END,
            "config" = EXCLUDED."config"
        `;
      }

      const programme = await prisma.programme.findUnique({
        where: { id },
        include: {
          eventFlow: {
            include: {
              events: { orderBy: { scheduledAt: "asc" } }
            }
          },
          participants: true
        }
      });

      const schedule = await scheduleOnFlowSave({ programmeId: id });

      return {
        programme: serializeProgramme(programme ?? flowProgramme),
        schedule,
      };
    })
  )
  .post("/:id/deploy", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const events = await findDeployableEvents({ programmeId: id });
      await resetFailedEventsForDeploy(events);

      const scheduleResult = await scheduleDeployedEvents(
        events
          .filter((event): event is typeof event & { scheduledAt: Date } => event.scheduledAt !== null)
          .map((event) => ({ id: event.id, scheduledAt: event.scheduledAt })),
        { checkAttachments: true }
      );

      if (scheduleResult.validationIssues.some((issue) => issue.errors.length > 0)) {
        return c.json(
          {
            ok: false,
            error: "Deploy validation failed",
            ...scheduleResult
          },
          400
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
          message: `Deployed ${scheduleResult.scheduled} pending events for programme ${id}`,
          meta: {
            programmeId: id,
            scheduled: scheduleResult.scheduled,
            immediate: scheduleResult.immediate,
            skipped: scheduleResult.skipped,
            nextEventAt: scheduleResult.nextEventAt,
            warnings: scheduleResult.validationIssues.flatMap((issue) => issue.warnings)
          }
        });
      } catch (err) {
        console.error("failed to add deploy notification", err);
      }

      return {
        ok: true,
        scheduled: scheduleResult.scheduled,
        immediate: scheduleResult.immediate,
        skipped: scheduleResult.skipped,
        nextEventAt: scheduleResult.nextEventAt,
        validationIssues: scheduleResult.validationIssues
      };
    })
  );

registerProgrammeDeliveryRoutes(programmesApp);

export const programmesRouter = programmesApp;
