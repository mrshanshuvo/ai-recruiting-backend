import { Router } from 'express';
import { ActionController } from '../controllers/action.controller';

export const actionRouter = Router();

// Confirmation gate endpoints per confirmation-gate.md & rest-endpoints.md
actionRouter.post('/actions/:id/confirm', ActionController.confirm);
actionRouter.post('/actions/:id/cancel', ActionController.cancel);
actionRouter.patch('/actions/:id/payload', ActionController.updatePayload);

