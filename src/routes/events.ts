import { Hono } from "hono";
import { EventBaseType, EventStatus, Prisma } from "../generated/client";
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { handleRoute } from "../lib/http";
import { serializeEvent } from "../lib/serializers";
import { EVENT_SCHEDULE_HASH } from "../jobs/utils";
import { createEventSchema, idParamSchema, programmeQuerySchema, updateEventSchema } from "../lib/schemas";

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
          scheduledAt: new Date(input.scheduledAt),
          status: (input.status ?? "pending") as EventStatus,
          config: (input.config ?? {}) as Prisma.InputJsonValue
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
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
          status: input.status as EventStatus | undefined,
          config: input.config as Prisma.InputJsonValue | undefined
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
      const event = await prisma.event.findUnique({ where: { id } });
      if (!event) throw new Error("Event not found");

      const updated = await prisma.event.update({
        where: { id },
        data: { status: EventStatus.pending }
      });

      await redis.hset(EVENT_SCHEDULE_HASH, { [id]: new Date().toISOString() });
      return serializeEvent(updated);
    })
  );
