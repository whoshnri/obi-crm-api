import Stripe from "stripe";

type StripeCustomerInput = {
  name: string;
  email: string;
  organisation?: string;
  phone?: string;
};

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  throw new Error("STRIPE_SECRET_KEY is required");
}

export const stripe = new Stripe(stripeSecretKey);

export async function createStripeCustomerForParticipant(_input: StripeCustomerInput): Promise<string | undefined> {
  // TODO: Replace this with stripe.customers.create and return the created customer id.
  return undefined;
}
