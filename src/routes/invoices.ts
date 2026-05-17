import { Hono } from "hono";
import { InvoiceStatus } from "../generated/client";
import { prisma } from "../lib/prisma";
import { handleRoute } from "../lib/http";
import { serializeInvoice } from "../lib/serializers";
import { createInvoiceSchema, idParamSchema, programmeQuerySchema, updateInvoiceSchema } from "../lib/schemas";

export const invoicesRouter = new Hono()
  .get("/", (c) =>
    handleRoute(c, async () => {
      const { programmeId } = programmeQuerySchema.parse(c.req.query());
      const invoices = await prisma.invoice.findMany({
        where: programmeId ? { programmeId } : undefined,
        include: {
          participants: { select: { participantId: true, invoiceTotal: true } },
          programme: { select: { name: true } }
        },
        orderBy: { dueDate: "asc" }
      });
      return invoices.map(serializeInvoice);
    })
  )
  .post("/", (c) =>
    handleRoute(c, async () => {
      const input = createInvoiceSchema.parse(await c.req.json());
      const invoice = await prisma.invoice.create({
        data: {
          programmeId: input.programmeId,
          amount: input.amount,
          currency: input.currency ?? "GBP",
          status: (input.status ?? "draft") as InvoiceStatus,
          dueDate: new Date(input.dueDate),
          paidAt: input.paidAt ? new Date(input.paidAt) : null,
          stripeInvoiceUrl: input.stripeInvoiceUrl,
          participants: {
            create: {
              participantId: input.participantId,
              programmeId: input.programmeId,
              invoiceTotal: input.amount
            }
          }
        },
        include: { participants: { select: { participantId: true, invoiceTotal: true } } }
      });
      return serializeInvoice(invoice);
    })
  )
  .get("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: { participants: { select: { participantId: true, invoiceTotal: true } } }
      });
      return invoice ? serializeInvoice(invoice) : null;
    })
  )
  .patch("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const input = updateInvoiceSchema.parse(await c.req.json());
      const invoice = await prisma.invoice.update({
        where: { id },
        data: {
          amount: input.amount,
          status: input.status as InvoiceStatus | undefined,
          dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
          paidAt: input.paidAt ? new Date(input.paidAt) : undefined,
          stripeInvoiceUrl: input.stripeInvoiceUrl,
          participants: input.amount
            ? {
                updateMany: {
                  where: {},
                  data: { invoiceTotal: input.amount }
                }
              }
            : undefined
        },
        include: { participants: { select: { participantId: true, invoiceTotal: true } } }
      });
      return serializeInvoice(invoice);
    })
  )
  .delete("/:id", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      await prisma.invoice.delete({ where: { id } });
      return { ok: true };
    })
  )
  .post("/:id/mark-paid", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const invoice = await prisma.invoice.update({
        where: { id },
        data: {
          status: InvoiceStatus.paid,
          paidAt: new Date()
        },
        include: { participants: { select: { participantId: true, invoiceTotal: true } } }
      });
      await prisma.programmeParticipant.updateMany({
        where: {
          programmeId: invoice.programmeId,
          participantId: { in: invoice.participants.map((participant) => participant.participantId) }
        },
        data: { paymentStatus: "paid" }
      });
      return serializeInvoice(invoice);
    })
  )
  .post("/:id/send-reminder", (c) =>
    handleRoute(c, async () => {
      const { id } = idParamSchema.parse(c.req.param());
      const invoice = await prisma.invoice.findUnique({ where: { id } });
      if (!invoice) throw new Error("Invoice not found");
      return true;
    })
  );
