import { Hono } from "hono";
import { EventBaseType, EventStatus, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { handleRoute } from "../lib/http.js";
import { serializeEvent } from "../lib/serializers.js";
import { cancelEventCron, runEventNow, scheduleEventCron } from "../lib/event-scheduler.js";
import { sendEventTestEmail, loadEmailTemplateForEvent } from "../lib/email/send-batch.js";
import { getAuthenticatedAdmin } from "../lib/auth.js";
import { addNotificationForAdmins } from "../lib/notifications.js";
import { createEventSchema, eventsQuerySchema, idParamSchema, updateEventSchema } from "../lib/schemas.js";

async function isEventInDeployedFlow(event: {
  eventFlowId: string | null;
  cohortEventFlowId: string | null;
}) {
  if (event.eventFlowId) {
    const flow = await prisma.eventFlow.findFirst({
      where: { id: event.eventFlowId, deployedAt: { not: null } },
      select: { id: true },
    });
    return Boolean(flow);
  }

  if (event.cohortEventFlowId) {
    const flow = await prisma.cohortEventFlow.findFirst({
      where: { id: event.cohortEventFlowId, deployedAt: { not: null } },
      select: { id: true },
    });
    return Boolean(flow);
  }

  return false;
}

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
      const existing = await prisma.event.findUnique({ where: { id } });
      if (!existing) throw new Error("Event not found");

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

      if (event.status === EventStatus.pending && (await isEventInDeployedFlow(existing))) {
        await cancelEventCron(id);
        await scheduleEventCron({ id: event.id, scheduledAt: event.scheduledAt });
      }

      return serializeEvent(event);
    })
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await cancelEventCron(id);
      await prisma.event.delete({ where: { id } });
      return { ok: true };
    })
  )
  .post("/:id/run", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const event = await prisma.event.findUnique({ where: { id } });
      if (!event) throw new Error("Event not found");
      if (event.status === "completed") {
        return c.json({ error: "Completed events cannot be run again" }, 400);
      }

      await runEventNow(id);

      const finalEvent = await prisma.event.findUnique({ where: { id } });

      try {
        const status = finalEvent?.status;
        const notifType = status === "completed" ? "event_completed" : status === "failed" ? "event_failed" : undefined;
        if (notifType && finalEvent) {
          await addNotificationForAdmins({
            type: notifType as "event_completed" | "event_failed",
            title: `Event ${status}`,
            message: `Event ${finalEvent.name} ${status}`,
            meta: { eventId: id, programmeId: finalEvent.programmeId }
          });
        }
      } catch (err) {
        console.error("failed to add notification", err);
      }

      const result = serializeEvent(finalEvent ?? event);
      return { ...result, isNewNotif: true };
    })
  )
  .post("/:id/test-send", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const admin = getAuthenticatedAdmin(c);

      const event = await prisma.event.findUnique({
        where: { id },
        include: { programme: true }
      });
      if (!event) throw new Error("Event not found");
      if (event.baseType !== EventBaseType.send_email) {
        throw new Error("Only email events support test send.");
      }

      const template = await loadEmailTemplateForEvent(event);
      await sendEventTestEmail({
        event,
        template,
        to: admin.email,
        toName: admin.email
      });

      return { ok: true, sentTo: admin.email };
    })
  );
