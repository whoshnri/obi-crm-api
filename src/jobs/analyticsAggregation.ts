import type { Prisma } from "../generated/client";
import { prisma } from "../lib/prisma";

export function currentAnalyticsPeriod(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function parseAnalyticsPeriod(period: string) {
  const match = period.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new Error("Invalid period format, expected YYYY-MM");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("Invalid period format, expected YYYY-MM");
  }

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}

export async function refreshOrganisationAnalytics(organisationId: string, period: string) {
  const { start, end } = parseAnalyticsPeriod(period);
  const cohorts = await prisma.cohort.findMany({
    where: { organisationId },
    select: {
      id: true,
      programmes: {
        select: { programmeId: true }
      }
    }
  });

  const cohortIds = cohorts.map((cohort) => cohort.id);
  const programmeIds = [...new Set(cohorts.flatMap((cohort) => cohort.programmes.map((link) => link.programmeId)))];

  const [enrollments, formSubmissions, portalLogins, resourceViews] = await Promise.all([
    cohortIds.length
      ? prisma.cohortParticipant.count({
          where: {
            cohortId: { in: cohortIds },
            joinedAt: { gte: start, lt: end }
          }
        })
      : Promise.resolve(0),
    cohortIds.length || programmeIds.length
      ? prisma.formSubmission.count({
          where: {
            createdAt: { gte: start, lt: end },
            OR: [
              ...(cohortIds.length ? [{ cohortId: { in: cohortIds } }] : []),
              ...(cohortIds.length ? [{ form: { cohortId: { in: cohortIds } } }] : []),
              ...(programmeIds.length ? [{ form: { programmeId: { in: programmeIds } } }] : [])
            ]
          }
        })
      : Promise.resolve(0),
    prisma.analyticsEvent.count({
      where: {
        organisationId,
        type: "portal_login",
        occurredAt: { gte: start, lt: end }
      }
    }),
    prisma.analyticsEvent.count({
      where: {
        organisationId,
        type: "resource_viewed",
        occurredAt: { gte: start, lt: end }
      }
    })
  ]);

  const metrics = {
    enrollments,
    formSubmissions,
    portalLogins,
    resourceViews,
    cohortCount: cohortIds.length
  } satisfies Record<string, number>;

  return prisma.organisationAnalytics.upsert({
    where: {
      organisationId_period: { organisationId, period }
    },
    create: {
      organisationId,
      period,
      metrics: metrics as Prisma.InputJsonValue
    },
    update: {
      metrics: metrics as Prisma.InputJsonValue,
      generatedAt: new Date()
    }
  });
}

export async function refreshCohortAnalytics(cohortId: string, period: string) {
  const { start, end } = parseAnalyticsPeriod(period);
  const cohort = await prisma.cohort.findUnique({
    where: { id: cohortId },
    select: {
      organisationId: true,
      programmes: {
        select: { programmeId: true }
      }
    }
  });

  if (!cohort) {
    throw new Error("Cohort not found");
  }

  const programmeIds = cohort.programmes.map((link) => link.programmeId);

  const [enrollments, formSubmissions, portalLogins, resourceViews] = await Promise.all([
    prisma.cohortParticipant.count({
      where: {
        cohortId,
        joinedAt: { gte: start, lt: end }
      }
    }),
    prisma.formSubmission.count({
      where: {
        createdAt: { gte: start, lt: end },
        OR: [
          { cohortId },
          { form: { cohortId } },
          ...(programmeIds.length ? [{ form: { programmeId: { in: programmeIds } } }] : [])
        ]
      }
    }),
    prisma.analyticsEvent.count({
      where: {
        cohortId,
        type: "portal_login",
        occurredAt: { gte: start, lt: end }
      }
    }),
    prisma.analyticsEvent.count({
      where: {
        cohortId,
        type: "resource_viewed",
        occurredAt: { gte: start, lt: end }
      }
    })
  ]);

  const metrics = {
    enrollments,
    formSubmissions,
    portalLogins,
    resourceViews,
    programmeCount: programmeIds.length
  } satisfies Record<string, number>;

  return prisma.cohortAnalytics.upsert({
    where: {
      cohortId_period: { cohortId, period }
    },
    create: {
      cohortId,
      period,
      metrics: metrics as Prisma.InputJsonValue
    },
    update: {
      metrics: metrics as Prisma.InputJsonValue,
      generatedAt: new Date()
    }
  });
}

export async function refreshParticipantProgress(
  participantId: string,
  programmeId: string,
  cohortId?: string | null
) {
  const [formsSubmitted, requestsDone, milestonesHit, lastEvent, programme] = await Promise.all([
    prisma.formSubmission.count({
      where: {
        respondentId: participantId,
        form: { programmeId }
      }
    }),
    prisma.participantRequest.count({
      where: {
        participantId,
        programmeId,
        response: { isNot: null }
      }
    }),
    prisma.analyticsEvent.count({
      where: {
        participantId,
        programmeId,
        type: "timeline_milestone_reached"
      }
    }),
    prisma.analyticsEvent.findFirst({
      where: { participantId, programmeId },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true }
    }),
    prisma.programme.findUnique({
      where: { id: programmeId },
      select: {
        forms: { where: { status: "published" }, select: { id: true } },
        timeline: {
          select: {
            milestones: { select: { id: true } }
          }
        },
        requests: {
          where: { participantId },
          select: { id: true }
        }
      }
    })
  ]);

  const totalForms = programme?.forms.length ?? 0;
  const totalMilestones = programme?.timeline?.milestones.length ?? 0;
  const totalRequests = programme?.requests.length ?? 0;
  const totalItems = Math.max(totalForms + totalMilestones + totalRequests, 1);
  const completedItems = Math.min(formsSubmitted + requestsDone + milestonesHit, totalItems);
  const completionPct = Math.round((completedItems / totalItems) * 1000) / 10;

  const progressCohortId = cohortId ?? null;
  const progressData = {
    completionPct,
    milestonesHit,
    formsSubmitted,
    requestsDone,
    lastActiveAt: lastEvent?.occurredAt ?? null
  };

  const existing = await prisma.participantProgress.findFirst({
    where: {
      participantId,
      programmeId,
      cohortId: progressCohortId
    }
  });

  if (existing) {
    return prisma.participantProgress.update({
      where: { id: existing.id },
      data: progressData
    });
  }

  return prisma.participantProgress.create({
    data: {
      participantId,
      programmeId,
      cohortId: progressCohortId,
      ...progressData
    }
  });
}

export async function runAnalyticsAggregation(period = currentAnalyticsPeriod()) {
  const [organisations, cohorts, enrolments] = await Promise.all([
    prisma.organisation.findMany({ select: { id: true } }),
    prisma.cohort.findMany({ select: { id: true } }),
    prisma.programmeParticipant.findMany({
      select: {
        participantId: true,
        programmeId: true,
        cohortId: true
      }
    })
  ]);

  await Promise.all(organisations.map((organisation) => refreshOrganisationAnalytics(organisation.id, period)));
  await Promise.all(cohorts.map((cohort) => refreshCohortAnalytics(cohort.id, period)));
  await Promise.all(
    enrolments.map((enrolment) =>
      refreshParticipantProgress(enrolment.participantId, enrolment.programmeId, enrolment.cohortId)
    )
  );

  return {
    period,
    organisations: organisations.length,
    cohorts: cohorts.length,
    participants: enrolments.length
  };
}
