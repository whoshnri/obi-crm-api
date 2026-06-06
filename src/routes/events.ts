import { Hono } from "hono";
import { EventBaseType, EventStatus, Prisma } from "../generated/client.js";
import { prisma } from "../lib/prisma.js";
import { redis, withRedisFallback } from "../lib/redis.js";
import { handleRoute } from "../lib/http.js";
import { serializeEvent } from "../lib/serializers.js";
import { EVENT_SCHEDULE_HASH } from "../jobs/utils.js";
import { runSendEmailEventNow } from "../jobs/sendEmailCron.js";
import { runSendInvoiceEventNow } from "../jobs/sendInvoiceCron.js";
import { addNotificationForAdmins } from "../lib/notifications.js";
import { createEventSchema, eventsQuerySchema, idParamSchema, updateEventSchema } from "../lib/schemas.js";

export const eventsRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const { programmeId, cohortId } = eventsQuerySchema.parse(c.req.query());
      const events = await prisma.event.findMany({
        where: {
          ...(programmeId ? { programmeId } : {}),
          ...(cohortId ? { cohortId } : {})
        },
        orderBy: { scheduledAt: "asc" }
      });
      return events.map(serializeEvent);
    })
  )
  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = createEventSchema.parse(await c.req.json());

      let eventFlowId: string | null = null;
      let cohortEventFlowId: string | null = input.cohortEventFlowId ?? null;
      let cohortId: string | null = input.cohortId ?? null;

      if (cohortId) {
        const cohortEventFlow =
          (cohortEventFlowId
            ? await prisma.cohortEventFlow.findUnique({ where: { id: cohortEventFlowId } })
            : null) ??
          (await prisma.cohortEventFlow.findUnique({ where: { cohortId } })) ??
          (await prisma.cohortEventFlow.create({
            data: { cohortId, flow: {}, deployedAt: null }
          }));
        cohortEventFlowId = cohortEventFlow.id;
      } else {
        const eventFlow =
          (await prisma.eventFlow.findUnique({ where: { programmeId: input.programmeId } })) ??
          (await prisma.eventFlow.create({
            data: { programmeId: input.programmeId, flow: {}, deployedAt: null }
          }));
        eventFlowId = eventFlow.id;
      }

      const event = await prisma.event.create({
        data: {
          name: input.name,
          programmeId: input.programmeId,
          eventFlowId,
          cohortEventFlowId,
          cohortId,
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

      await withRedisFallback(() => redis.hset(EVENT_SCHEDULE_HASH, { [id]: new Date().toISOString() }), 0);

      if (event.baseType === EventBaseType.send_email) {
        await runSendEmailEventNow(id);
      }

      if (event.baseType === EventBaseType.send_invoice) {
        await runSendInvoiceEventNow(id);
      }

      const finalEvent = await prisma.event.findUnique({ where: { id } });

      // create notifications for admins
      try {
        const status = (finalEvent ?? updated).status;
        const notifType = status === "completed" ? "event_completed" : status === "failed" ? "event_failed" : undefined;
        if (notifType) {
          await addNotificationForAdmins({
            type: notifType as any,
            title: `Event ${status}`,
            message: `Event ${(finalEvent ?? updated).name} ${status}`,
            meta: { eventId: id, programmeId: (finalEvent ?? updated).programmeId }
          });
        }
      } catch (err) {
        // best-effort; don't block response
        console.error("failed to add notification", err);
      }

      const result = serializeEvent(finalEvent ?? updated);
      // inform client that we added a notification to the cache
      // (small non-sensitive flag)
      return { ...result, isNewNotif: true };
    })
  );
