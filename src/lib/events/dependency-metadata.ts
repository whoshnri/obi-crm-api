import type { Event, Prisma } from "@prisma/client";

type FlowMap = Record<string, string>;

export function getParentEventId(flow: FlowMap, eventId: string) {
  const parentId = flow[eventId];
  return typeof parentId === "string" && parentId.trim() ? parentId : null;
}

export function buildDependencyMetadata(input: {
  event: Pick<Event, "id" | "scheduledAt">;
  flow: FlowMap;
  parentStatus?: string | null;
}) {
  const parentEventId = getParentEventId(input.flow, input.event.id);

  return {
    dependency: parentEventId
      ? {
          parentEventId,
          parentStatus: input.parentStatus ?? null,
          independentExecution: true
        }
      : null,
    scheduledAt: input.event.scheduledAt.toISOString()
  };
}

export async function loadParentEventStatus(parentEventId: string | null) {
  if (!parentEventId) return null;

  const { prisma } = await import("../prisma.js");
  const parent = await prisma.event.findUnique({
    where: { id: parentEventId },
    select: { id: true, status: true, name: true }
  });

  return parent
    ? {
        id: parent.id,
        name: parent.name,
        status: parent.status
      }
    : null;
}

export function dependencyMetadataToJson(metadata: ReturnType<typeof buildDependencyMetadata>): Prisma.InputJsonValue {
  return metadata as Prisma.InputJsonValue;
}
