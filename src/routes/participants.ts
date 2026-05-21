import { Hono } from "hono";
import { PaymentStatus, Prisma } from "../generated/client";
import { prisma } from "../lib/prisma";
import { handleRoute } from "../lib/http";
import { serializeProgramParticipant } from "../lib/serializers";
import { createParticipantSchema, idParamSchema, programmeQuerySchema, updateParticipantSchema } from "../lib/schemas";
import { createStripeCustomerForParticipant } from "../lib/stripe";

export const participantsRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const { programmeId } = programmeQuerySchema.parse(c.req.query());
      const participants = await prisma.programmeParticipant.findMany({
        where: { programmeId },
        include: { programme: true, participant: true },
        orderBy: { createdAt: "desc" }
      });

      return participants.map(serializeProgramParticipant);
    })
  )
  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = createParticipantSchema.parse(await c.req.json());
      if (!input.programmeId) throw new Error("Programme id is required.");
      const programmeId = input.programmeId;
      const participantMetadata = (input.metadata ?? {}) as Prisma.InputJsonValue;
      const programmeParticipantMetadata = (input.programmeParticipantMetadata ?? {}) as Prisma.InputJsonValue;

      const programParticipant = await prisma.$transaction(async (tx) => {
        const stripeCustomerId = await createStripeCustomerForParticipant({
          name: input.name,
          email: input.email,
          organisation: input.organisation,
          phone: input.phone
        });

        const participant = await tx.participant.create({
          data: {
            name: input.name,
            email: input.email,
            organisation: input.organisation,
            address: input.address,
            phone: input.phone,
            socialLinks: input.socialLinks ?? [],
            photoId: input.photoId,
            stripeCustomerId,
            notes: input.notes,
            metadata: participantMetadata
          }
        });

        return tx.programmeParticipant.create({
          data: {
            programmeId,
            participantId: participant.id,
            paymentStatus: (input.paymentStatus ?? "not_invoiced") as PaymentStatus,
            metadata: programmeParticipantMetadata
          },
          include: { programme: true, participant: true, invoice: true }
        });
      });

      return serializeProgramParticipant(programParticipant);
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const participant = await prisma.programmeParticipant.findUnique({
        where: { id },
        include: { programme: true, participant: true, invoice: true }
      });
      
      return participant ? serializeProgramParticipant(participant) : null
  
    })
  )
  .patch("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateParticipantSchema.parse(await c.req.json());
      const participantMetadata = input.metadata as Prisma.InputJsonValue | undefined;
      const programmeParticipantMetadata = input.programmeParticipantMetadata as Prisma.InputJsonValue | undefined;
      const programParticipant = await prisma.programmeParticipant.findUniqueOrThrow({
        where: { id },
        select: { participantId: true }
      });

      await prisma.$transaction(async (tx) => {
        await tx.participant.update({
          where: { id: programParticipant.participantId },
          data: {
            name: input.name,
            email: input.email,
            organisation: input.organisation,
            address: input.address,
            phone: input.phone,
            socialLinks: input.socialLinks,
            photoId: input.photoId,
            notes: input.notes,
            stripeCustomerId: input.stripeCustomerId,
            metadata: participantMetadata
          }
        });

        if (input.paymentStatus || input.programmeParticipantMetadata) {
          await tx.programmeParticipant.update({
            where: { id },
            data: {
              paymentStatus: input.paymentStatus as PaymentStatus | undefined,
              metadata: programmeParticipantMetadata
            }
          });
        }
      });

      return { ok: true, id };
    })
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.programmeParticipant.delete({ where: { id } });
      return { ok: true };
    })
  )
  .post("/:id/mark-paid", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.programmeParticipant.update({
        where: { id },
        data: { paymentStatus: PaymentStatus.paid }
      });
      return { ok: true, id };
    })
  );
