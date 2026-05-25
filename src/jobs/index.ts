import { startSendEmailCron } from "./sendEmailCron.js";
import { startSendInvoiceCron } from "./sendInvoiceCron.js";

let started = false;

export function startJobs() {
  if (started) return;
  started = true;

  startSendEmailCron();
  startSendInvoiceCron();
}

startJobs();
