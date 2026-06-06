import { Hono } from "hono";
import type Stripe from "stripe";
import { InvoiceStatus, PaymentStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { stripe } from "../lib/stripe.js";
import { errorMessage } from "../jobs/utils.js";

async function markInvoicePaid(stripeInvoiceId: string) {
  const invoice = await prisma.participantInvoice.update({
    where: { stripeInvoiceId },
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
}

async function markInvoiceOverdue(stripeInvoiceId: string, updateProgrammeParticipant: boolean) {
  const invoice = await prisma.participantInvoice.update({
    where: { stripeInvoiceId },
    data: { status: InvoiceStatus.overdue }
  });

  if (!updateProgrammeParticipant) return;

  await prisma.programmeParticipant.updateMany({
    where: {
      programmeId: invoice.programmeId,
      participantId: invoice.participantId
    },
    data: { paymentStatus: PaymentStatus.overdue }
  });
}

async function handleStripeEvent(event: Stripe.Event) {
  if (event.type === "invoice.paid") {
    const stripeInvoiceId = (event.data.object as Stripe.Invoice).id;
    await markInvoicePaid(stripeInvoiceId);
    return;
  }

  if (event.type === "invoice.payment_failed") {
    const stripeInvoiceId = (event.data.object as Stripe.Invoice).id;
    await markInvoiceOverdue(stripeInvoiceId, true);
    return;
  }

  if (event.type === "invoice.marked_uncollectible") {
    const stripeInvoiceId = (event.data.object as Stripe.Invoice).id;
    await markInvoiceOverdue(stripeInvoiceId, false);
  }
}

export const webhooksRouter = new Hono().post("/stripe", async (c) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return c.json({ error: "STRIPE_WEBHOOK_SECRET is required" }, 500);
  }

  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ error: "Missing stripe-signature header" }, 400);
  }

  const rawBody = await c.req.text();

  try {
    const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    void handleStripeEvent(event).catch((error) => {
      console.error("[stripe:webhook:handler:error]", JSON.stringify({ eventId: event.id, type: event.type, message: errorMessage(error) }));
    });
    return c.json({ received: true });
  } catch (error) {
    console.error("[stripe:webhook:signature:error]", JSON.stringify({ message: errorMessage(error) }));
    return c.json({ error: "Invalid Stripe webhook signature" }, 400);
  }
});
