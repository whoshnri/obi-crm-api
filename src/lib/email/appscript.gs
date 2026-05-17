function doPost(e) {
  try {
    const payload = parsePayload(e);
    const email = payload.resources || payload;
    validateEmail(email);

    MailApp.sendEmail({
      to: email.to,
      subject: email.subject,
      body: email.body,
      name: email.fromName || undefined,
    });

    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error.message || 'Unable to send email.',
    });
  }
}

function parsePayload(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Missing request body.');
  }

  return JSON.parse(e.postData.contents);
}

function validateEmail(email) {
  if (!email || !email.to || !email.subject || !email.body) {
    throw new Error('Email payload must include to, subject, and body.');
  }
}

function jsonResponse(body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
