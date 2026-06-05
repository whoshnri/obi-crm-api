import { prisma } from "./prisma";

const MAX_TIMEOUT_MS = 2_147_483_647;
const scheduledOpportunityJobs = new Map<string, ReturnType<typeof setTimeout>>();

export function getOpportunityCronJobId(opportunityId: string, pipelineStepId: string) {
  return `obi-opportunity-${opportunityId}-${pipelineStepId}`;
}

function scheduleTimeout(cronJobId: string, scheduledAt: Date, run: () => Promise<void>) {
  const delay = scheduledAt.getTime() - Date.now();
  const timeout = setTimeout(
    () => {
      if (delay > MAX_TIMEOUT_MS) {
        scheduleTimeout(cronJobId, scheduledAt, run);
        return;
      }

      scheduledOpportunityJobs.delete(cronJobId);
      void run();
    },
    Math.max(0, Math.min(delay, MAX_TIMEOUT_MS))
  );
  timeout.unref?.();
  scheduledOpportunityJobs.set(cronJobId, timeout);
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
  scheduleTimeout(event.cronJobId, event.scheduledAt, async () => {
    await executeOpportunityEvent(event.id);
  });
}

export async function cancelOpportunityCron(cronJobId: string) {
  const timeout = scheduledOpportunityJobs.get(cronJobId);
  if (!timeout) return;

  clearTimeout(timeout);
  scheduledOpportunityJobs.delete(cronJobId);
}
