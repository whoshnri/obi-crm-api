import { Hono } from "hono";
import { EventBaseType, EventInstanceType, EventStatus, Prisma } from "../generated/client";
import { prisma } from "../lib/prisma";
import { handleRoute } from "../lib/http";
import { serializeProgramme } from "../lib/serializers";
import {
  createProgrammeSchema,
  eventFlowSchema,
  idParamSchema,
  participantDefinitionSchema,
  saveProgrammeEventFlowStateSchema,
  updateProgrammeSchema
} from "../lib/schemas";
import { sendEmailEvent } from "../lib/email/send-event-email";

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
          startDate: new Date(input.startDate),
          eventFlow: input.eventFlow ?? {},
          participantDefinition: input.participantDefinition ?? defaultParticipantDefinition
        }
      });
      return serializeProgramme(programme);
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const programme = await prisma.programme.findUnique({
        where: { id },
        include: {
          events: { orderBy: { scheduledAt: "asc" } },
          formTables: true,
          invoices: true,
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
          startDate: input.startDate ? new Date(input.startDate) : undefined,
          eventFlow: input.eventFlow,
          participantDefinition: input.participantDefinition
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
        data: { eventFlow }
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

      if (eventsWithIds.length > 0) {
        await prisma.$executeRaw`
          INSERT INTO "Event" ("id", "name", "programmeId", "baseType", "instanceType", "scheduledAt", "status", "config")
          VALUES ${Prisma.join(
            eventsWithIds.map((event) => Prisma.sql`(
              ${event.id},
              ${event.name},
              ${id},
              ${(event.baseType as EventBaseType)}::"EventBaseType",
              ${(event.instanceType ?? "send_admin_reminder") as EventInstanceType}::"EventInstanceType",
              ${new Date(event.scheduledAt)},
              ${(event.status ?? "pending") as EventStatus}::"EventStatus",
              ${JSON.stringify(event.config ?? {})}::jsonb
            )`)
          )}
          ON CONFLICT ("id") DO UPDATE SET
            "name" = EXCLUDED."name",
            "baseType" = EXCLUDED."baseType",
            "instanceType" = EXCLUDED."instanceType",
            "scheduledAt" = EXCLUDED."scheduledAt",
            "status" = EXCLUDED."status",
            "config" = EXCLUDED."config"
        `;
      }

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

      const programme = await prisma.programme.update({
        where: { id },
        data: { eventFlow: remappedFlow },
        include: {
          events: { orderBy: { scheduledAt: "asc" } }
        }
      });

      return serializeProgramme(programme);
    })
  )
  .post("/:id/deploy", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const events = await prisma.event.findMany({
        where: { programmeId: id, status: "pending" },
        select: { id: true, scheduledAt: true }
      });
      const cron = (Bun as any).cron;

      if (typeof cron === "function") {
        for (const event of events) {
          const jobId = `obi-programme-${id}-${event.id}`;
          await cron(jobId, event.scheduledAt, () => {
            void (async () => {
              const scheduledEvent = await prisma.event.findUnique({
                where: { id: event.id },
                include: {
                  programme: {
                    select: {
                      id: true,
                      name: true,
                      startDate: true,
                      participants: { include: { participant: true } }
                    }
                  }
                }
              });
              if (!scheduledEvent) return;

              await prisma.event.update({ where: { id: event.id }, data: { status: EventStatus.processing } });
              try {
                await sendEmailEvent({
                  event: scheduledEvent,
                  programme: scheduledEvent.programme,
                  participants: scheduledEvent.programme.participants.map((entry) => ({
                    ...entry.participant,
                    programmes: [{ programmeId: entry.programmeId, paymentStatus: entry.paymentStatus }]
                  }))
                });
                await prisma.event.update({ where: { id: event.id }, data: { status: EventStatus.completed } });
              } catch (error) {
                console.error("[programme:cron:error]", JSON.stringify({ jobId, eventId: event.id, error: error instanceof Error ? error.message : String(error) }));
                await prisma.event.update({ where: { id: event.id }, data: { status: EventStatus.failed } });
              }
            })();
          });
        }
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
