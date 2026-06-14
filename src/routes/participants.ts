import { Hono } from "hono";
import { PaymentStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { hashParticipantPassword } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import { handleRoute } from "../lib/http.js";
import {
  serializeParticipantDirectory,
  serializeProgramParticipant,
} from "../lib/serializers.js";
import { createParticipantSchema, idParamSchema, programmeQuerySchema, updateParticipantSchema } from "../lib/schemas.js";
import { ensureCohortParticipantRelations } from "../lib/cohort-links.js";
import { createStripeCustomerForParticipant } from "../lib/stripe.js";

const participantDirectoryInclude = {
  organisations: {
    include: { organisation: true },
    orderBy: [{ isPrimary: "desc" as const }, { joinedAt: "asc" as const }],
  },
  programmes: {
    include: { programme: true },
    orderBy: { createdAt: "desc" as const },
  },
} satisfies Prisma.ParticipantInclude;

const programmeParticipantInclude = {
  programme: true,
  cohort: { include: { organisation: true } },
  invoice: true,
  participant: {
    include: {
      organisations: {
        include: { organisation: true },
        orderBy: [{ isPrimary: "desc" as const }, { joinedAt: "asc" as const }],
      },
      progress: {
        orderBy: { updatedAt: "desc" as const },
        take: 1,
        select: { completionPct: true, programmeId: true },
      },
    },
  },
} satisfies Prisma.ProgrammeParticipantInclude;

function programmeParticipantListInclude(programmeId?: string) {
  return {
    programme: true,
    cohort: { include: { organisation: true } },
    participant: {
      include: {
        organisations: {
          include: { organisation: true },
          orderBy: [{ isPrimary: "desc" as const }, { joinedAt: "asc" as const }],
        },
        progress: {
          where: programmeId ? { programmeId } : undefined,
          orderBy: { updatedAt: "desc" as const },
          take: 1,
          select: { completionPct: true, programmeId: true },
        },
      },
    },
  } satisfies Prisma.ProgrammeParticipantInclude;
}

async function linkParticipantToOrganisation(
  tx: Prisma.TransactionClient,
  participantId: string,
  organisationId?: string,
) {
  if (!organisationId) return;

  await tx.organisationParticipant.upsert({
    where: {
      organisationId_participantId: {
        organisationId,
        participantId,
      },
    },
    create: {
      organisationId,
      participantId,
      isPrimary: true,
    },
    update: {},
  });
}

export const participantsRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const query = c.req.query();
      const { programmeId } = programmeQuerySchema.parse(query);
      const view = query.view === "enrollments" ? "enrollments" : "base";

      if (programmeId || view === "enrollments") {
        const participants = await prisma.programmeParticipant.findMany({
          where: programmeId ? { programmeId } : undefined,
          include: programmeParticipantListInclude(programmeId),
          orderBy: { createdAt: "desc" },
        });

        return participants.map((entry) =>
          serializeProgramParticipant({
            ...entry,
            progress: entry.participant.progress.filter(
              (record) => !programmeId || record.programmeId === entry.programmeId,
            ),
          }),
        );
      }

      const participants = await prisma.participant.findMany({
        include: participantDirectoryInclude,
        orderBy: { createdAt: "desc" },
      });

      return participants.map(serializeParticipantDirectory);
    }),
  )

  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = createParticipantSchema.parse(await c.req.json());
      const participantMetadata = (input.metadata ?? {}) as Prisma.InputJsonValue;
      const programmeParticipantMetadata = (input.programmeParticipantMetadata ?? {}) as Prisma.InputJsonValue;

      if (!input.programmeId) {
        const participant = await prisma.$transaction(async (tx) => {
          const stripeCustomerId = await createStripeCustomerForParticipant({
            name: input.name,
            email: input.email,
            organisation: input.organisation,
            phone: input.phone,
          });

          const created = await tx.participant.create({
            data: {
              name: input.name,
              email: input.email,
              password: input.password ? await hashParticipantPassword(input.password) : undefined,
              organisation: input.organisation,
              address: input.address,
              phone: input.phone,
              socialLinks: input.socialLinks ?? [],
              photoId: input.photoId,
              stripeCustomerId,
              notes: input.notes,
              metadata: participantMetadata,
            } as Prisma.ParticipantCreateInput,
          });

          await linkParticipantToOrganisation(tx, created.id, input.organisationId);

          return tx.participant.findUniqueOrThrow({
            where: { id: created.id },
            include: participantDirectoryInclude,
          });
        });

        return serializeParticipantDirectory(participant);
      }

      const programmeId = input.programmeId;

      const programParticipant = await prisma.$transaction(async (tx) => {
        const stripeCustomerId = await createStripeCustomerForParticipant({
          name: input.name,
          email: input.email,
          organisation: input.organisation,
          phone: input.phone,
        });

        const participant = await tx.participant.create({
          data: {
            name: input.name,
            email: input.email,
            password: input.password ? await hashParticipantPassword(input.password) : undefined,
            organisation: input.organisation,
            address: input.address,
            phone: input.phone,
            socialLinks: input.socialLinks ?? [],
            photoId: input.photoId,
            stripeCustomerId,
            notes: input.notes,
            metadata: participantMetadata,
          } as Prisma.ParticipantCreateInput,
        });

        const programmeParticipant = await tx.programmeParticipant.create({
          data: {
            programmeId,
            participantId: participant.id,
            cohortId: input.cohortId ?? null,
            paymentStatus: (input.paymentStatus ?? "not_invoiced") as PaymentStatus,
            metadata: programmeParticipantMetadata,
          },
          include: { programme: true, participant: true, invoice: true },
        });

        if (input.cohortId) {
          await ensureCohortParticipantRelations(tx, {
            cohortId: input.cohortId,
            participantId: participant.id,
            programmeId,
          });
        } else {
          await linkParticipantToOrganisation(tx, participant.id, input.organisationId);
        }

        return programmeParticipant;
      });

      const fullProgrammeParticipant = await prisma.programmeParticipant.findUniqueOrThrow({
        where: { id: programParticipant.id },
        include: programmeParticipantInclude,
      });

      try {
        const { addNotificationForAdmins } = await import("../lib/notifications.js");
        await addNotificationForAdmins({
          type: "participant_enrolled",
          title: "New participant enrolled",
          message: `${programParticipant.participant.name} enrolled in programme ${programParticipant.programme.name}`,
          meta: { programmeId: programParticipant.programmeId, participantId: programParticipant.participantId },
        });
      } catch (err) {
        console.error("failed to add participant notification", err);
      }

      return serializeProgramParticipant({
        ...fullProgrammeParticipant,
        progress: fullProgrammeParticipant.participant.progress.filter(
          (record) => record.programmeId === fullProgrammeParticipant.programmeId,
        ),
      });
    }),
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());

      const enrollment = await prisma.programmeParticipant.findUnique({
        where: { id },
        include: programmeParticipantInclude,
      });

      if (enrollment) {
        return serializeProgramParticipant({
          ...enrollment,
          progress: enrollment.participant.progress.filter(
            (record) => record.programmeId === enrollment.programmeId,
          ),
        });
      }

      const participant = await prisma.participant.findUnique({
        where: { id },
        include: participantDirectoryInclude,
      });

      return participant ? serializeParticipantDirectory(participant) : null;
    }),
  )
  .patch("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateParticipantSchema.parse(await c.req.json());
      const participantMetadata = input.metadata as Prisma.InputJsonValue | undefined;
      const programmeParticipantMetadata = input.programmeParticipantMetadata as Prisma.InputJsonValue | undefined;

      const enrollment = await prisma.programmeParticipant.findUnique({
        where: { id },
        select: { participantId: true },
      });

      if (enrollment) {
        await prisma.$transaction(async (tx) => {
          await tx.participant.update({
            where: { id: enrollment.participantId },
            data: {
              name: input.name,
              email: input.email,
              password: input.password ? await hashParticipantPassword(input.password) : undefined,
              organisation: input.organisation,
              address: input.address,
              phone: input.phone,
              socialLinks: input.socialLinks,
              photoId: input.photoId,
              notes: input.notes,
              stripeCustomerId: input.stripeCustomerId,
              metadata: participantMetadata,
            } as Prisma.ParticipantUpdateInput,
          });

          if (input.paymentStatus || input.programmeParticipantMetadata) {
            await tx.programmeParticipant.update({
              where: { id },
              data: {
                paymentStatus: input.paymentStatus as PaymentStatus | undefined,
                metadata: programmeParticipantMetadata,
              },
            });
          }
        });

        return { ok: true, id };
      }

      const participant = await prisma.participant.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!participant) {
        throw new Error("Participant not found.");
      }

      await prisma.participant.update({
        where: { id },
        data: {
          name: input.name,
          email: input.email,
          password: input.password ? await hashParticipantPassword(input.password) : undefined,
          organisation: input.organisation,
          address: input.address,
          phone: input.phone,
          socialLinks: input.socialLinks,
          photoId: input.photoId,
          notes: input.notes,
          stripeCustomerId: input.stripeCustomerId,
          metadata: participantMetadata,
        } as Prisma.ParticipantUpdateInput,
      });

      return { ok: true, id };
    }),
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());

      const enrollment = await prisma.programmeParticipant.findUnique({
        where: { id },
        select: { id: true },
      });

      if (enrollment) {
        await prisma.programmeParticipant.delete({ where: { id } });
        return { ok: true };
      }

      await prisma.participant.delete({ where: { id } });
      return { ok: true };
    }),
  )
  .post("/:id/mark-paid", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.programmeParticipant.update({
        where: { id },
        data: { paymentStatus: PaymentStatus.paid },
      });
      return { ok: true, id };
    }),
  );
