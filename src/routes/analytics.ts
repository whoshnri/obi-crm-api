import { Hono } from "hono";
import { z } from "zod";
import { currentAnalyticsPeriod, runAnalyticsAggregation } from "../jobs/analyticsAggregation";
import { handleRoute } from "../lib/http";
import { prisma } from "../lib/prisma";
import { idParamSchema } from "../lib/schemas";

const periodQuerySchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/).optional()
});

const participantProgressQuerySchema = z.object({
  programmeId: z.string().min(1),
  cohortId: z.string().optional()
});

function serializeAnalyticsRecord(record: {
  id: string;
  period: string;
  metrics: unknown;
  generatedAt: Date;
}) {
  return {
    id: record.id,
    period: record.period,
    metrics: record.metrics,
    generatedAt: record.generatedAt.toISOString()
  };
}

function serializeParticipantProgress(record: {
  id: string;
  participantId: string;
  programmeId: string;
  cohortId: string | null;
  completionPct: number;
  milestonesHit: number;
  formsSubmitted: number;
  requestsDone: number;
  lastActiveAt: Date | null;
  updatedAt: Date;
}) {
  return {
    id: record.id,
    participantId: record.participantId,
    programmeId: record.programmeId,
    cohortId: record.cohortId ?? undefined,
    completionPct: record.completionPct,
    milestonesHit: record.milestonesHit,
    formsSubmitted: record.formsSubmitted,
    requestsDone: record.requestsDone,
    lastActiveAt: record.lastActiveAt?.toISOString(),
    updatedAt: record.updatedAt.toISOString()
  };
}

export const analyticsRouter = new Hono()
  .get("/organisations/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const { period = currentAnalyticsPeriod() } = periodQuerySchema.parse(c.req.query());

      const analytics = await prisma.organisationAnalytics.findUnique({
        where: {
          organisationId_period: {
            organisationId: id,
            period
          }
        }
      });

      return analytics ? serializeAnalyticsRecord(analytics) : null;
    })
  )
  .get("/cohorts/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const { period = currentAnalyticsPeriod() } = periodQuerySchema.parse(c.req.query());

      const analytics = await prisma.cohortAnalytics.findUnique({
        where: {
          cohortId_period: {
            cohortId: id,
            period
          }
        }
      });

      return analytics ? serializeAnalyticsRecord(analytics) : null;
    })
  )
  .get("/participants/:participantId/progress", (c) =>
    handleRoute(c, async () => {
      const participantId = c.req.param("participantId");
      const { programmeId, cohortId } = participantProgressQuerySchema.parse(c.req.query());

      const progress = await prisma.participantProgress.findFirst({
        where: {
          participantId,
          programmeId,
          ...(cohortId ? { cohortId } : {})
        },
        orderBy: { updatedAt: "desc" }
      });

      return progress ? serializeParticipantProgress(progress) : null;
    })
  )
  .post("/refresh", (c) =>
    handleRoute(c, async () => {
      const admin = c.get("admin" as never) as { role?: string } | undefined;
      if (!admin || admin.role !== "super") {
        return c.json({ error: "Forbidden" }, 403);
      }

      const body = await c.req.json().catch(() => ({}));
      const period =
        typeof body === "object" && body !== null && "period" in body && typeof body.period === "string"
          ? body.period
          : currentAnalyticsPeriod();

      const result = await runAnalyticsAggregation(period);
      return { ok: true, ...result };
    })
  );
