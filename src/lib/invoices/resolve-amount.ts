import type { Programme } from "@prisma/client";

export function resolveInvoiceAmount(programme: Pick<Programme, "costPerParticipant">) {
  const amount = programme.costPerParticipant;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return amount;
}

export function invoiceAmountErrorMessage() {
  return "Set cost per participant on the programme before sending invoices.";
}
