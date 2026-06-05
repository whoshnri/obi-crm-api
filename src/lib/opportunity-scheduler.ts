import { cancelScheduledJob, scheduleOneOffJob } from "../jobs/scheduler.js";
import { prisma } from "./prisma.js";

export function getOpportunityCronJobId(opportunityId: string, pipelineStepId: string) {
  return `obi-opportunity-${opportunityId}-${pipelineStepId}`;
}

export async function executeOpportunityEvent(eventId: string) {
  const event = await prisma.opportunityEvent.findUnique({ where: { id: eventId } });
  if (!event || event.status !== "scheduled") return;
  if (event.scheduledAt > new Date()) return;

  try {
    await prisma.opportunityEvent.update({
      where: { id: event.id },
      data: {
        status: "completed",
        completedAt: new Date()
      }
    });
  } catch (error) {
    await prisma.opportunityEvent.update({
      where: { id: event.id },
      data: {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown opportunity event error"
      }
    });
  } finally {
    await cancelOpportunityCron(event.cronJobId);
  }
}

export async function scheduleOpportunityCron(event: { id: string; cronJobId: string; scheduledAt: Date }) {
  await cancelOpportunityCron(event.cronJobId);
  scheduleOneOffJob(event.cronJobId, event.scheduledAt, async () => {
    await executeOpportunityEvent(event.id);
  });
}

export async function cancelOpportunityCron(cronJobId: string) {
  cancelScheduledJob(cronJobId);
}
