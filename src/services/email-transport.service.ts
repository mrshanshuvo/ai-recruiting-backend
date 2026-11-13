import nodemailer from 'nodemailer';
import { env } from '../config/env';

let cachedTransporter: nodemailer.Transporter | null = null;
let activeTransportType: 'ethereal' | 'smtp' | 'local' = 'ethereal';
let forceEtherealFailure = false;

export interface SendMailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendMailResult {
  messageId: string;
  previewUrl?: string;
  transport: 'ethereal' | 'smtp' | 'local';
}

export class EmailTransportService {
  public static setForceEtherealFailure(force: boolean): void {
    forceEtherealFailure = force;
    if (force) cachedTransporter = null;
  }

  public static resetTransporter(): void {
    cachedTransporter = null;
    forceEtherealFailure = false;
  }

  private static async getTransporter(): Promise<{
    transporter?: nodemailer.Transporter;
    transportType: 'ethereal' | 'smtp' | 'local';
  }> {
    if (cachedTransporter) {
      return { transporter: cachedTransporter, transportType: activeTransportType };
    }

    if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
      cachedTransporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT || 587,
        secure: env.SMTP_PORT === 465,
        auth: {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
        },
      });
      activeTransportType = 'smtp';
      return { transporter: cachedTransporter, transportType: 'smtp' };
    }

    if (!forceEtherealFailure) {
      try {
        const testAccount = await nodemailer.createTestAccount();
        cachedTransporter = nodemailer.createTransport({
          host: testAccount.smtp.host,
          port: testAccount.smtp.port,
          secure: testAccount.smtp.secure,
          auth: {
            user: testAccount.user,
            pass: testAccount.pass,
          },
        });
        activeTransportType = 'ethereal';
        console.log(`[EmailTransport] Initialized Ethereal sandbox transport (${testAccount.user})`);
        return { transporter: cachedTransporter, transportType: 'ethereal' };
      } catch (err) {
        console.warn('[EmailTransport] Ethereal account creation failed. Falling back to local transport:', err);
      }
    } else {
      console.warn('[EmailTransport] Forced Ethereal failure active. Falling back to local transport.');
    }

    activeTransportType = 'local';
    return { transportType: 'local' };
  }

  public static async sendMail(options: SendMailOptions): Promise<SendMailResult> {
    const { transporter, transportType } = await this.getTransporter();

    if (transportType === 'local' || !transporter) {
      const localId = `local-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      console.log(`[EmailTransport:LOCAL] Dispatched email to ${options.to} (ID: ${localId}):`, {
        subject: options.subject,
        textPreview: options.text.substring(0, 100),
      });
      return {
        messageId: localId,
        transport: 'local',
      };
    }

    const info = await transporter.sendMail({
      from: '"Aironauts Recruiting Team" <recruiting@aironauts.example.com>',
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    });

    const previewUrl = nodemailer.getTestMessageUrl(info) || undefined;
    if (previewUrl) {
      console.log(`[EmailTransport] Email sent to ${options.to}. Preview URL: ${previewUrl}`);
    }

    return {
      messageId: info.messageId,
      previewUrl,
      transport: transportType,
    };
  }
}

