import nodemailer from 'nodemailer';
import { env } from '../config/env';

let cachedTransporter: nodemailer.Transporter | null = null;

export interface SendMailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendMailResult {
  messageId: string;
  previewUrl?: string;
}

export class EmailTransportService {
  private static async getTransporter(): Promise<nodemailer.Transporter> {
    if (cachedTransporter) {
      return cachedTransporter;
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
      return cachedTransporter;
    }

    // Default Ethereal sandbox transport per ADR-0010 and OQ-02
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

    console.log(`[EmailTransport] Initialized Ethereal sandbox transport (${testAccount.user})`);
    return cachedTransporter;
  }

  public static async sendMail(options: SendMailOptions): Promise<SendMailResult> {
    const transporter = await this.getTransporter();

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
    };
  }
}

