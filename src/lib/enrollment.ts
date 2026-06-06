import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { createStripeCustomerForParticipant } from "./stripe.js";

export async function enrollParticipant(params: {
  programmeId: string;
  cohortId?: string;
  name: string;
  email: string;
  organisation?: string;
  phone?: string;
  address?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  organisationId?: string;
}) {
  const normalizedEmail = params.email.trim().toLowerCase();
  const participantMetadata = (params.metadata ?? {}) as Prisma.InputJsonValue;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.participant.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, stripeCustomerId: true }
    });

    const stripeCustomerId =
      existing?.stripeCustomerId ??
      (await createStripeCustomerForParticipant({
        name: params.name,
        email: normalizedEmail,
        organisation: params.organisation,
        phone: params.phone
      }));

    const participant = await tx.participant.upsert({
      where: { email: normalizedEmail },
      create: {
        name: params.name,
        email: normalizedEmail,
        organisation: params.organisation,
        phone: params.phone,
        address: params.address,
        notes: params.notes,
        stripeCustomerId,
        metadata: participantMetadata
      },
      update: {
        name: params.name,
        organisation: params.organisation ?? undefined,
        phone: params.phone ?? undefined,
        address: params.address ?? undefined,
        notes: params.notes ?? undefined,
        metadata: Object.keys(params.metadata ?? {}).length ? participantMetadata : undefined
      }
    });

    let cohortParticipant = undefined;
    const programmeIdsToEnroll = new Set<string>([params.programmeId]);

    if (params.cohortId) {
      cohortParticipant = await tx.cohortParticipant.upsert({
        where: {
          cohortId_participantId: {
            cohortId: params.cohortId,
            participantId: participant.id
          }
        },
        create: {
          cohortId: params.cohortId,
          participantId: participant.id
        },
        update: {}
      });

      await tx.cohortProgramme.upsert({
        where: {
          cohortId_programmeId: {
            cohortId: params.cohortId,
            programmeId: params.programmeId
          }
        },
        create: {
          cohortId: params.cohortId,
          programmeId: params.programmeId
        },
        update: {}
      });

      const cohortProgrammes = await tx.cohortProgramme.findMany({
        where: { cohortId: params.cohortId },
        select: { programmeId: true }
      });

      for (const link of cohortProgrammes) {
        programmeIdsToEnroll.add(link.programmeId);
      }
    }

    let programmeParticipant = await tx.programmeParticipant.upsert({
      where: {
        programmeId_participantId: {
          programmeId: params.programmeId,
          participantId: participant.id
        }
      },
      create: {
        programmeId: params.programmeId,
        participantId: participant.id,
        cohortId: params.cohortId ?? null
      },
      update: {
        cohortId: params.cohortId ?? undefined
      }
    });

    for (const programmeId of programmeIdsToEnroll) {
      if (programmeId === params.programmeId) continue;

      await tx.programmeParticipant.upsert({
        where: {
          programmeId_participantId: {
            programmeId,
            participantId: participant.id
          }
        },
        create: {
          programmeId,
          participantId: participant.id,
          cohortId: params.cohortId ?? null
        },
        update: {
          cohortId: params.cohortId ?? undefined
        }
      });
    }

    if (params.organisationId) {
      await tx.organisationParticipant.upsert({
        where: {
          organisationId_participantId: {
            organisationId: params.organisationId,
            participantId: participant.id
          }
        },
        create: {
          organisationId: params.organisationId,
          participantId: participant.id
        },
        update: {}
      });
    }

    return {
      participant,
      programmeParticipant,
      cohortParticipant
    };
  });
}
