import { Router } from 'express';
import { ChatController } from '../controllers/chat.controller';

export const chatRouter = Router();

// Conversation management
chatRouter.post('/conversations', ChatController.createConversation);

// Chat messages and stream
chatRouter.get('/chat/messages/:conversationId', ChatController.getMessages);
chatRouter.get('/chat/stream/:conversationId', ChatController.streamEvents);
chatRouter.post('/chat/message', ChatController.sendMessage);

