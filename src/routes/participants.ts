import { Hono } from "hono";
import { PaymentStatus } from "../generated/client";
import { prisma } from "../lib/prisma";
import { handleRoute } from "../lib/http";
import { serializeParticipant } from "../lib/serializers";
import { createParticipantSchema, idParamSchema, programmeQuerySchema, updateParticipantSchema } from "../lib/schemas";

export const participantsRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const { programmeId } = programmeQuerySchema.parse(c.req.query());
      const participants = await prisma.participant.findMany({
        where: programmeId ? { programmes: { some: { programmeId } } } : undefined,
        include: { programmes: { select: { programmeId: true, paymentStatus: true } } },
        orderBy: { createdAt: "desc" }
      });
      return participants.map((participant) => serializeParticipant(participant, programmeId));
    })
  )
  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = createParticipantSchema.parse(await c.req.json());
      const participant = await prisma.$transaction(async (tx) => {
        const record = await tx.participant.upsert({
          where: { email: input.email },
          create: {
            name: input.name,
            email: input.email,
            organisation: input.organisation,
            address: input.address,
            phone: input.phone,
            socialLinks: input.socialLinks ?? [],
            photoId: input.photoId,
            notes: input.notes,
            metadata: (input.metadata ?? {}) as any
          },
          update: {
            name: input.name,
            organisation: input.organisation,
            address: input.address,
            phone: input.phone,
            socialLinks: input.socialLinks,
            photoId: input.photoId,
            notes: input.notes,
            metadata: input.metadata as any
          }
        });

        if (input.programmeId) {
          await tx.programmeParticipant.upsert({
            where: {
              programmeId_participantId: {
                programmeId: input.programmeId,
                participantId: record.id
              }
            },
            create: {
              programmeId: input.programmeId,
              participantId: record.id,
              paymentStatus: (input.paymentStatus ?? "not_invoiced") as PaymentStatus
            },
            update: {
              paymentStatus: input.paymentStatus as PaymentStatus | undefined
            }
          });
        }

        return tx.participant.findUniqueOrThrow({
          where: { id: record.id },
          include: { programmes: { select: { programmeId: true, paymentStatus: true } } }
        });
      });
      return serializeParticipant(participant, input.programmeId);
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const participant = await prisma.participant.findUnique({
        where: { id },
        include: { programmes: { select: { programmeId: true, paymentStatus: true } } }
      });
      return participant ? serializeParticipant(participant) : null;
    })
  )
  .patch("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateParticipantSchema.parse(await c.req.json());
      const participant = await prisma.participant.update({
        where: { id },
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
          stripeInvoiceIds: input.stripeInvoiceIds,
          metadata: input.metadata as any,
          programmes: input.paymentStatus
            ? {
                updateMany: {
                  where: {},
                  data: { paymentStatus: input.paymentStatus as PaymentStatus }
                }
              }
            : undefined
        },
        include: { programmes: { select: { programmeId: true, paymentStatus: true } } }
      });
      return serializeParticipant(participant);
    })
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.participant.delete({ where: { id } });
      return { ok: true };
    })
  )
  .post("/:id/mark-paid", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const participant = await prisma.participant.update({
        where: { id },
        data: {
          programmes: {
            updateMany: {
              where: {},
              data: { paymentStatus: PaymentStatus.paid }
            }
          }
        },
        include: { programmes: { select: { programmeId: true, paymentStatus: true } } }
      });
      return serializeParticipant(participant);
    })
  );
