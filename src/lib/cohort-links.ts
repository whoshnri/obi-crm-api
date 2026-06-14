import type { Prisma } from "@prisma/client";

type TransactionClient = Prisma.TransactionClient;

export async function ensureCohortParticipantRelations(
  tx: TransactionClient,
  params: { cohortId: string; participantId: string; programmeId?: string },
) {
  const cohort = await tx.cohort.findUniqueOrThrow({
    where: { id: params.cohortId },
    select: {
      organisationId: true,
      programmes: { select: { programmeId: true } },
    },
  });

  await tx.cohortParticipant.upsert({
    where: {
      cohortId_participantId: {
        cohortId: params.cohortId,
        participantId: params.participantId,
      },
    },
    create: {
      cohortId: params.cohortId,
      participantId: params.participantId,
    },
    update: {},
  });

  if (cohort.organisationId) {
    await tx.organisationParticipant.upsert({
      where: {
        organisationId_participantId: {
          organisationId: cohort.organisationId,
          participantId: params.participantId,
        },
      },
      create: {
        organisationId: cohort.organisationId,
        participantId: params.participantId,
      },
      update: {},
    });
  }

  const programmeIds = new Set(cohort.programmes.map((link) => link.programmeId));
  if (params.programmeId) {
    programmeIds.add(params.programmeId);
    await tx.cohortProgramme.upsert({
      where: {
        cohortId_programmeId: {
          cohortId: params.cohortId,
          programmeId: params.programmeId,
        },
      },
      create: {
        cohortId: params.cohortId,
        programmeId: params.programmeId,
      },
      update: {},
    });
  }

  for (const programmeId of programmeIds) {
    await tx.programmeParticipant.upsert({
      where: {
        programmeId_participantId: {
          programmeId,
          participantId: params.participantId,
        },
      },
      create: {
        programmeId,
        participantId: params.participantId,
        cohortId: params.cohortId,
      },
      update: {
        cohortId: params.cohortId,
      },
    });
  }
}
