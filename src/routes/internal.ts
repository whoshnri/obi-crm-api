import { Hono } from "hono";
import { handleRoute, HttpError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { executeScheduledEvent } from "../lib/event-scheduler.js";
import { executeOpportunityEvent } from "../lib/opportunity-scheduler.js";

type SupabaseReqPayload = {
  job_id: string;
  job_type: string;
  payload: Record<string, any>;
};

export const internalRouter = new Hono().post("/jobs/run", async (c) => {
  return handleRoute(c, async () => {
    // auth
    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      console.log("no header");
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (authHeader !== process.env.INTERNAL_QUEUE_SECRET) {
      console.log("invalid token");
      return c.json({ error: "Unauthorized" }, 401);
    }

    // run jobs
    const payload: SupabaseReqPayload = await c.req.json();

    if (payload.job_type === "opportunity_event") {
      const event = await prisma.opportunityEvent.findUnique({
        where: { cronJobId: payload.job_id },
      });
      if (!event) {
        throw new HttpError(
          `Opportunity event with cronJobId ${payload.job_id} not found`,
          404,
        );
      }
      await executeOpportunityEvent(event.id);
      return {
        success: true,
        message: `Opportunity event ${event.id} executed successfully`,
      };
    } else if (payload.job_type === "participant_event" || !payload.job_type) {
      const event = await prisma.event.findUnique({
        where: { id: payload.job_id },
      });
      if (!event) {
        throw new HttpError(
          `Participant event with id ${payload.job_id} not found`,
          404,
        );
      }
      await executeScheduledEvent(payload.job_id);
      return {
        success: true,
        message: `Participant event ${payload.job_id} executed successfully`,
      };
    } else {
      throw new HttpError(`Unknown job type: ${payload.job_type}`, 400);
    }
  });
});
