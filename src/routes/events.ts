import { Hono } from "hono";
import { EventBaseType, EventInstanceType, EventStatus } from "../generated/client";
import { prisma } from "../lib/prisma";
import { handleRoute } from "../lib/http";
import { serializeEvent } from "../lib/serializers";
import { createEventSchema, idParamSchema, programmeQuerySchema, updateEventSchema } from "../lib/schemas";
import { sendEmailEvent } from "../lib/email/send-event-email";

export const eventsRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const { programmeId } = programmeQuerySchema.parse(c.req.query());
      const events = await prisma.event.findMany({
        where: programmeId ? { programmeId } : undefined,
        orderBy: { scheduledAt: "asc" }
      });
      return events.map(serializeEvent);
    })
  )
  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = createEventSchema.parse(await c.req.json());
      const event = await prisma.event.create({
        data: {
          name: input.name,
          programmeId: input.programmeId,
          baseType: input.baseType as EventBaseType,
          instanceType: (input.instanceType ?? "send_admin_reminder") as EventInstanceType,
          scheduledAt: new Date(input.scheduledAt),
          status: (input.status ?? "pending") as EventStatus,
          config: (input.config ?? {}) as any
        }
      });
      return serializeEvent(event);
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const event = await prisma.event.findUnique({ where: { id } });
      return event ? serializeEvent(event) : null;
    })
  )
  .patch("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateEventSchema.parse(await c.req.json());
      const event = await prisma.event.update({
        where: { id },
        data: {
          name: input.name,
          baseType: input.baseType as EventBaseType | undefined,
          instanceType: input.instanceType as EventInstanceType | undefined,
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
          status: input.status as EventStatus | undefined,
          config: input.config as any
        }
      });
      return serializeEvent(event);
    })
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.event.delete({ where: { id } });
      return { ok: true };
    })
  )
  .post("/:id/run", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const event = await prisma.event.findUnique({
        where: { id },
        include: {
          programme: {
            select: {
              id: true,
              name: true,
              startDate: true,
              participants: {
                include: {
                  participant: true
                }
              }
            }
          }
        }
      });
      if (!event) throw new Error("Event not found");

      await prisma.event.update({
        where: { id },
        data: { status: EventStatus.processing }
      });

      try {
        await sendEmailEvent({
          event,
          programme: event.programme,
          participants: event.programme.participants.map((entry) => ({
            ...entry.participant,
            programmes: [{ programmeId: entry.programmeId, paymentStatus: entry.paymentStatus }]
          }))
        });

        const updated = await prisma.event.update({
          where: { id },
          data: { status: EventStatus.completed }
        });
        return serializeEvent(updated);
      } catch (error) {
        await prisma.event.update({
          where: { id },
          data: { status: EventStatus.failed }
        });
        throw error;
      }
    })
  );
