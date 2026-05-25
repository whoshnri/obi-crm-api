import { prisma } from "./prisma";

export function getOpportunityCronJobId(opportunityId: string, pipelineStepId: string) {
  return `obi-opportunity-${opportunityId}-${pipelineStepId}`;
}

function toCronExpression(date: Date) {
  return `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`;
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
  const cron = (Bun as any).cron;

  if (!cron) {
    console.warn("[opportunity:scheduler]", JSON.stringify({ eventId: event.id, cronJobId: event.cronJobId, skipped: true }));
    return;
  }

  await cron(
    event.cronJobId,
    toCronExpression(event.scheduledAt),
    async () => {
      await executeOpportunityEvent(event.id);
    }
  );
}

export async function cancelOpportunityCron(cronJobId: string) {
  const cron = (Bun as any).cron;
  if (!cron) return;

  if (typeof cron.remove === "function") {
    await cron.remove(cronJobId);
    return;
  }

  if (typeof cron.delete === "function") {
    await cron.delete(cronJobId);
  }
}
