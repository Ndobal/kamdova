import type { EnvBindings } from '../types';

/**
 * Outbound email, deliberately not wired to a provider yet.
 *
 * The spec says to keep gateways out of the foundation, so this logs the
 * message and returns. Swapping in Cloudflare Email Service, Resend or
 * Postmark later means implementing `send` -- no caller changes.
 *
 * In development the token is echoed back in the API response so the flow is
 * testable without a mailbox. `deliveredInline` is what tells the route it may
 * do that; it is false in every non-development environment, so a production
 * misconfiguration cannot leak a reset token into an HTTP response.
 */
export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
}

export interface MailResult {
  sent: boolean;
  deliveredInline: boolean;
}

export async function sendEmail(env: EnvBindings, message: OutboundEmail): Promise<MailResult> {
  const isDevelopment = env.ENVIRONMENT === 'development';
  console.log(`[mail] to=${message.to} subject=${message.subject}`);
  if (isDevelopment) console.log(`[mail] body:\n${message.body}`);
  return { sent: false, deliveredInline: isDevelopment };
}

export const verificationEmail = (token: string): Omit<OutboundEmail, 'to'> => ({
  subject: 'Verify your KamDova account',
  body: `Welcome to KamDova.\n\nVerification code: ${token}\n\nThis code expires in 24 hours.`,
});

export const passwordResetEmail = (token: string): Omit<OutboundEmail, 'to'> => ({
  subject: 'Reset your KamDova password',
  body: `A password reset was requested for your account.\n\nReset code: ${token}\n\nThis code expires in 1 hour. If this was not you, you can ignore this message.`,
});
