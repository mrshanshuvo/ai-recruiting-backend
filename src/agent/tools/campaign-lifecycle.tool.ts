import { z } from 'zod';
import mongoose from 'mongoose';
import { Campaign, Conversation } from '../../models';
import { PendingActionService } from '../../services/pending-action.service';

export const pauseCampaignInputSchema = z.object({
  campaignId: z
    .string()
    .optional()
    .describe('The ID of the outreach campaign to pause. If omitted, uses the active campaign for the job linked to this conversation.'),
  jobId: z
    .string()
    .optional()
    .describe('Optional job ID to pause outreach campaign for.'),
});

export async function executePauseCampaign(
  input: z.infer<typeof pauseCampaignInputSchema>,
  conversationId: string
) {
  let campaign: any = null;
  if (input.campaignId && mongoose.Types.ObjectId.isValid(input.campaignId)) {
    campaign = await Campaign.findById(input.campaignId).lean();
  }
  if (!campaign && input.jobId && mongoose.Types.ObjectId.isValid(input.jobId)) {
    campaign = await Campaign.findOne({ jobId: input.jobId }).sort({ createdAt: -1 }).lean();
  }
  if (!campaign && conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
    const conv = await Conversation.findById(conversationId).lean();
    if (conv?.jobId) {
      campaign = await Campaign.findOne({ jobId: conv.jobId }).sort({ createdAt: -1 }).lean();
    }
  }
  if (!campaign) {
    campaign = await Campaign.findOne().sort({ createdAt: -1 }).lean();
  }

  if (!campaign) {
    return {
      success: false,
      error: 'No active campaign found to pause.',
    };
  }

  const campaignIdStr = campaign._id.toString();
  const pendingAction = await PendingActionService.createAction({
    conversationId,
    actionType: 'PAUSE_CAMPAIGN',
    payload: {
      campaignId: campaignIdStr,
      campaignName: campaign.name,
    },
  });

  return {
    success: true,
    message: `I prepared this, please confirm. I proposed pausing the campaign "${campaign.name}".`,
    card: {
      cardType: 'status_update' as const,
      actionId: pendingAction._id.toString(),
      status: 'pending' as const,
      payload: {
        entityType: 'campaign',
        entityId: campaignIdStr,
        title: campaign.name,
        action: 'PAUSE_CAMPAIGN',
        description: `Pause all outreach follow-ups for "${campaign.name}"`,
      },
    },
  };
}

export const resumeCampaignInputSchema = z.object({
  campaignId: z
    .string()
    .optional()
    .describe('The ID of the outreach campaign to resume. If omitted, uses the active campaign for the job linked to this conversation.'),
  jobId: z
    .string()
    .optional()
    .describe('Optional job ID to resume outreach campaign for.'),
});

export async function executeResumeCampaign(
  input: z.infer<typeof resumeCampaignInputSchema>,
  conversationId: string
) {
  let campaign: any = null;
  if (input.campaignId && mongoose.Types.ObjectId.isValid(input.campaignId)) {
    campaign = await Campaign.findById(input.campaignId).lean();
  }
  if (!campaign && input.jobId && mongoose.Types.ObjectId.isValid(input.jobId)) {
    campaign = await Campaign.findOne({ jobId: input.jobId }).sort({ createdAt: -1 }).lean();
  }
  if (!campaign && conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
    const conv = await Conversation.findById(conversationId).lean();
    if (conv?.jobId) {
      campaign = await Campaign.findOne({ jobId: conv.jobId }).sort({ createdAt: -1 }).lean();
    }
  }
  if (!campaign) {
    campaign = await Campaign.findOne().sort({ createdAt: -1 }).lean();
  }

  if (!campaign) {
    return {
      success: false,
      error: 'No campaign found to resume.',
    };
  }

  const campaignIdStr = campaign._id.toString();
  const pendingAction = await PendingActionService.createAction({
    conversationId,
    actionType: 'RESUME_CAMPAIGN',
    payload: {
      campaignId: campaignIdStr,
      campaignName: campaign.name,
    },
  });

  return {
    success: true,
    message: `I prepared this, please confirm. I proposed resuming the campaign "${campaign.name}".`,
    card: {
      cardType: 'status_update' as const,
      actionId: pendingAction._id.toString(),
      status: 'pending' as const,
      payload: {
        entityType: 'campaign',
        entityId: campaignIdStr,
        title: campaign.name,
        action: 'RESUME_CAMPAIGN',
        description: `Resume active outreach follow-ups for "${campaign.name}"`,
      },
    },
  };
}
