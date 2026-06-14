function doPost(e) {
  try {
    const payload = parsePayload(e);

    if (payload.type === 'email_batch') {
      return jsonResponse(sendEmailBatch(payload.resources || payload));
    }

    const email = payload.resources || payload;
    validateEmail(email);
    return jsonResponse(sendSingleEmail(email));
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error.message || 'Unable to send email.',
    });
  }
}

function sendSingleEmail(email) {
  MailApp.sendEmail({
    to: email.to,
    subject: email.subject,
    htmlBody: email.bodyHtml || email.body,
    body: email.bodyText || stripHtml(email.bodyHtml || email.body || ''),
    name: email.fromName || undefined,
  });

  return { ok: true, sent: 1, failed: 0 };
}

function sendEmailBatch(batch) {
  const fromName = batch.fromName || undefined;
  const attachments = buildAttachments(batch.attachments || []);
  let sent = 0;
  let failed = 0;
  const errors = [];

  (batch.messages || []).forEach(function (message) {
    try {
      validateMessage(message);
      const messageAttachments = filterAttachmentsForMessage(attachments, message.attachmentIds);

      MailApp.sendEmail({
        to: message.to,
        subject: message.subject,
        htmlBody: message.bodyHtml,
        body: message.bodyText || stripHtml(message.bodyHtml || ''),
        name: fromName,
        attachments: messageAttachments,
      });

      sent += 1;
    } catch (error) {
      failed += 1;
      errors.push(error.message || 'Unknown email send error');
    }
  });

  if (failed > 0 && sent === 0) {
    return {
      ok: false,
      sent: sent,
      failed: failed,
      error: errors.join(' | '),
    };
  }

  return {
    ok: true,
    sent: sent,
    failed: failed,
    error: failed > 0 ? errors.join(' | ') : undefined,
  };
}

function buildAttachments(attachments) {
  return attachments.map(function (attachment) {
    const bytes = Utilities.base64Decode(attachment.contentBase64);
    const blob = Utilities.newBlob(bytes, attachment.mimeType || 'application/octet-stream', attachment.filename || 'attachment');
    return {
      id: attachment.id,
      blob: blob,
    };
  });
}

function filterAttachmentsForMessage(attachments, attachmentIds) {
  if (!attachmentIds || !attachmentIds.length) {
    return attachments.map(function (item) { return item.blob; });
  }

  return attachments
    .filter(function (item) { return attachmentIds.indexOf(item.id) !== -1; })
    .map(function (item) { return item.blob; });
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parsePayload(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Missing request body.');
  }

  return JSON.parse(e.postData.contents);
}

function validateEmail(email) {
  if (!email || !email.to || !email.subject || !(email.body || email.bodyHtml)) {
    throw new Error('Email payload must include to, subject, and body.');
  }
}

function validateMessage(message) {
  if (!message || !message.to || !message.subject || !message.bodyHtml) {
    throw new Error('Batch message must include to, subject, and bodyHtml.');
  }
}

function jsonResponse(body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
