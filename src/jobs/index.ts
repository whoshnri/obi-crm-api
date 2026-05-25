import { startSendEmailCron } from "./sendEmailCron";
import { startSendInvoiceCron } from "./sendInvoiceCron";

let started = false;

export function startJobs() {
  if (started) return;
  started = true;

  startSendEmailCron();
  startSendInvoiceCron();
}

startJobs();
