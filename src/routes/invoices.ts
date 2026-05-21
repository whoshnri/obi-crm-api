import { Hono } from "hono";
import { InvoiceStatus, PaymentStatus, Prisma } from "../generated/client";
import { prisma } from "../lib/prisma";
import { handleRoute } from "../lib/http";
import { serializeInvoice } from "../lib/serializers";
import { createInvoiceSchema, idParamSchema, programmeQuerySchema, updateInvoiceSchema } from "../lib/schemas";

function totalLineItems(lineItems: Array<{ amount: number }>) {
  return lineItems.reduce((total, item) => total + item.amount, 0);
}

async function resolveProgrammeParticipant(input: {
  programmeId: string;
  programmeParticipantId?: string;
  participantId?: string;
}) {
  if (input.programmeParticipantId) {
    return prisma.programmeParticipant.findUniqueOrThrow({
      where: { id: input.programmeParticipantId },
      include: { participant: true }
    });
  }

  const byProgrammeParticipantId = await prisma.programmeParticipant.findFirst({
    where: { id: input.participantId, programmeId: input.programmeId },
    include: { participant: true }
  });

  if (byProgrammeParticipantId) return byProgrammeParticipantId;

  return prisma.programmeParticipant.findUniqueOrThrow({
    where: {
      programmeId_participantId: {
        programmeId: input.programmeId,
        participantId: input.participantId as string
      }
    },
    include: { participant: true }
  });
}

export const invoicesRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const { programmeId } = programmeQuerySchema.parse(c.req.query());
      const invoices = await prisma.participantInvoice.findMany({
        where: programmeId ? { programmeId } : undefined,
        orderBy: { dueDate: "asc" }
      });
      return invoices.map(serializeInvoice);
    })
  )
  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = createInvoiceSchema.parse(await c.req.json());
      const programmeParticipant = await resolveProgrammeParticipant(input);
      const lineItems = input.lineItems ?? [];
      const amount = input.amount ?? totalLineItems(lineItems);

      const invoice = await prisma.$transaction(async (tx) => {
        const participantInvoice = await tx.participantInvoice.upsert({
          where: {
            programmeId_participantId: {
              programmeId: programmeParticipant.programmeId,
              participantId: programmeParticipant.participantId
            }
          },
          create: {
            programmeId: programmeParticipant.programmeId,
            participantId: programmeParticipant.participantId,
            amount,
            currency: input.currency ?? "GBP",
            status: (input.status ?? "draft") as InvoiceStatus,
            dueDate: new Date(input.dueDate),
            paidAt: input.paidAt ? new Date(input.paidAt) : null,
            stripeInvoiceId: input.stripeInvoiceId,
            stripeInvoiceUrl: input.stripeInvoiceUrl,
            stripeInvoiceItemIds: input.stripeInvoiceItemIds ?? [],
            lineItems: lineItems as unknown as Prisma.InputJsonValue,
            metadata: (input.metadata ?? {}) as Prisma.InputJsonValue
          },
          update: {
            amount,
            currency: input.currency ?? "GBP",
            status: (input.status ?? "draft") as InvoiceStatus,
            dueDate: new Date(input.dueDate),
            paidAt: input.paidAt ? new Date(input.paidAt) : null,
            stripeInvoiceId: input.stripeInvoiceId,
            stripeInvoiceUrl: input.stripeInvoiceUrl,
            stripeInvoiceItemIds: input.stripeInvoiceItemIds ?? [],
            lineItems: lineItems as unknown as Prisma.InputJsonValue,
            metadata: (input.metadata ?? {}) as Prisma.InputJsonValue
          }
        });

        await tx.programmeParticipant.update({
          where: { id: programmeParticipant.id },
          data: {
            invoiceId: participantInvoice.id,
            paymentStatus: (input.status === "paid" ? PaymentStatus.paid : PaymentStatus.invoiced)
          }
        });

        return participantInvoice;
      });

      return serializeInvoice(invoice);
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const invoice = await prisma.participantInvoice.findUnique({ where: { id } });
      return invoice ? serializeInvoice(invoice) : null;
    })
  )
  .patch("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateInvoiceSchema.parse(await c.req.json());
      const lineItems = input.lineItems;
      const amount = input.amount ?? (lineItems ? totalLineItems(lineItems) : undefined);

      const invoice = await prisma.participantInvoice.update({
        where: { id },
        data: {
          amount,
          currency: input.currency,
          status: input.status as InvoiceStatus | undefined,
          dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
          paidAt: input.paidAt ? new Date(input.paidAt) : undefined,
          stripeInvoiceId: input.stripeInvoiceId,
          stripeInvoiceUrl: input.stripeInvoiceUrl,
          stripeInvoiceItemIds: input.stripeInvoiceItemIds,
          lineItems: lineItems as unknown as Prisma.InputJsonValue | undefined,
          metadata: input.metadata as Prisma.InputJsonValue | undefined
        }
      });

      if (input.status) {
        await prisma.programmeParticipant.updateMany({
          where: { programmeId: invoice.programmeId, participantId: invoice.participantId },
          data: { paymentStatus: input.status === "paid" ? PaymentStatus.paid : PaymentStatus.invoiced }
        });
      }

      return serializeInvoice(invoice);
    })
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.$transaction(async (tx) => {
        await tx.programmeParticipant.updateMany({
          where: { invoiceId: id },
          data: { invoiceId: null, paymentStatus: PaymentStatus.not_invoiced }
        });
        await tx.participantInvoice.delete({ where: { id } });
      });
      return { ok: true };
    })
  )
  .post("/:id/mark-paid", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const invoice = await prisma.participantInvoice.update({
        where: { id },
        data: {
          status: InvoiceStatus.paid,
          paidAt: new Date()
        }
      });
      await prisma.programmeParticipant.updateMany({
        where: {
          programmeId: invoice.programmeId,
          participantId: invoice.participantId
        },
        data: { paymentStatus: PaymentStatus.paid }
      });
      return serializeInvoice(invoice);
    })
  )
  .post("/:id/send-reminder", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const invoice = await prisma.participantInvoice.findUnique({ where: { id } });
      if (!invoice) throw new Error("Invoice not found");
      return { ok: true };
    })
  );
