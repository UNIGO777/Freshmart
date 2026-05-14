const nodemailer = require('nodemailer');
const logger = require('./logger');

// Lazy-initialised transporter promise — resolves once (production or Ethereal dev).
let _transporterPromise = null;

function getTransporterPromise() {
  if (_transporterPromise) return _transporterPromise;

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    // Production: use configured SMTP
    _transporterPromise = Promise.resolve(
      nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      }),
    );
  } else {
    // Dev fallback: auto-create an Ethereal test account.
    // Emails are sent for real and can be previewed at https://ethereal.email
    _transporterPromise = nodemailer.createTestAccount().then((account) => {
      logger.info(`[EMAIL-DEV] Ethereal account ready: ${account.user}`);
      logger.info('[EMAIL-DEV] Preview sent emails at https://ethereal.email');
      return nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: { user: account.user, pass: account.pass },
      });
    });
  }

  return _transporterPromise;
}

const FROM_ADDRESS = process.env.SMTP_FROM || 'FreshMart Support <support@freshmart.in>';

/**
 * Send an email. Non-fatal — catches and logs errors.
 * In dev (no SMTP env vars) emails are sent to Ethereal and a preview URL is logged.
 * @param {{ to: string, subject: string, text?: string, html?: string }} opts
 */
async function sendEmail({ to, subject, text, html }) {
  try {
    const transporter = await getTransporterPromise();
    const info = await transporter.sendMail({ from: FROM_ADDRESS, to, subject, text, html });
    logger.info(`Email sent to ${to} — messageId: ${info.messageId}`);
    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) logger.info(`[EMAIL-DEV] Preview URL: ${preview}`);
  } catch (err) {
    logger.error(`Failed to send email to ${to}: ${err.message}`);
  }
}

module.exports = { sendEmail };
