import type { AnalyticsEventType, Prisma } from "../generated/client.js";
import { prisma } from "./prisma.js";

export type TrackAnalyticsEventInput = {
  type: AnalyticsEventType;
  participantId?: string;
  cohortId?: string;
  programmeId?: string;
  organisationId?: string;
  payload?: Record<string, unknown>;
};

export async function trackAnalyticsEvent(input: TrackAnalyticsEventInput) {
  return prisma.analyticsEvent.create({
    data: {
      type: input.type,
      participantId: input.participantId,
      cohortId: input.cohortId,
      programmeId: input.programmeId,
      organisationId: input.organisationId,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
    },
  });
}
