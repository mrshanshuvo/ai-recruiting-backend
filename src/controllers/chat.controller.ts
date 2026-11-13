import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env';
import { Conversation, Message } from '../models';
import { createConversationSubscriber, publishConversationEvent } from '../services/event-bus.service';

const sendMessageSchema = z.object({
  conversationId: z.string().refine((val) => mongoose.Types.ObjectId.isValid(val), {
    message: 'Invalid conversationId format',
  }),
  text: z.string().min(1, 'Message text cannot be empty'),
});

export class ChatController {
  public static async createConversation(_req: Request, res: Response): Promise<void> {
    try {
      const conversation = await Conversation.create({
        title: 'New Conversation',
      });

      const welcomeText =
        'Hello! I am your AI recruiting co-worker. How can I help you source, screen, or reach out to candidates today? You can start by pasting a Job Description (or providing a link to one).';

      const welcomeMessage = await Message.create({
        conversationId: conversation._id,
        role: 'assistant',
        parts: [{ type: 'text', text: welcomeText }],
      });

      res.status(201).json({
        success: true,
        conversationId: conversation._id.toString(),
        greeting: {
          messageId: welcomeMessage._id.toString(),
          text: welcomeText,
        },
      });
    } catch (error) {
      console.error('[ChatController.createConversation]', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create conversation',
        },
      });
    }
  }

  public static async getMessages(req: Request, res: Response): Promise<void> {
    try {
      const { conversationId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(conversationId)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid conversationId format',
          },
        });
        return;
      }

      const messages = await Message.find({ conversationId })
        .sort({ createdAt: 1 })
        .lean();

      res.status(200).json({
        success: true,
        messages,
      });
    } catch (error) {
      console.error('[ChatController.getMessages]', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch messages',
        },
      });
    }
  }

  public static async streamEvents(req: Request, res: Response): Promise<void> {
    const { conversationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid conversationId format',
        },
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': env.CORS_ORIGIN,
      'Access-Control-Allow-Credentials': 'true',
    });

    let eventId = 0;

    // Send initial comment heartbeat
    res.write(`:keep-alive heartbeat ${new Date().toISOString()}\n\n`);

    // Heartbeat ping every 15 seconds
    const heartbeatInterval = setInterval(() => {
      res.write(`:keep-alive heartbeat ${new Date().toISOString()}\n\n`);
    }, 15000);

    // Redis Pub/Sub subscription for this conversation
    const subscriber = createConversationSubscriber(conversationId, (eventType, data) => {
      eventId += 1;
      res.write(`event: ${eventType}\nid: ${eventId}\ndata: ${JSON.stringify(data)}\n\n`);
    });

    req.on('close', async () => {
      clearInterval(heartbeatInterval);
      await subscriber.close();
      res.end();
    });
  }

  public static async sendMessage(req: Request, res: Response): Promise<void> {
    try {
      const parsed = sendMessageSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid message payload',
            details: parsed.error.format(),
          },
        });
        return;
      }

      const { conversationId, text } = parsed.data;

      const conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        res.status(404).json({
          success: false,
          error: {
            code: 'ENTITY_NOT_FOUND',
            message: 'Conversation not found',
          },
        });
        return;
      }

      // 1. Save user message
      const userMessage = await Message.create({
        conversationId,
        role: 'user',
        parts: [{ type: 'text', text }],
      });

      // 2. Placeholder assistant reply for Checkpoint 2 (agent loop connected in Checkpoint 3)
      const placeholderText = `I received your message: "${text}". Assistant loop will be active in Checkpoint 3.`;

      const assistantMessage = await Message.create({
        conversationId,
        role: 'assistant',
        parts: [{ type: 'text', text: placeholderText }],
      });

      // Stream placeholder assistant reply to SSE stream via Redis Pub/Sub
      setTimeout(async () => {
        await publishConversationEvent(conversationId, 'CHAT_PART', {
          messageId: assistantMessage._id.toString(),
          partIndex: 0,
          part: {
            type: 'text',
            text: placeholderText,
          },
        });
      }, 50);

      res.status(200).json({
        success: true,
        messageId: userMessage._id.toString(),
        conversationId,
      });
    } catch (error) {
      console.error('[ChatController.sendMessage]', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to process message',
        },
      });
    }
  }
}

