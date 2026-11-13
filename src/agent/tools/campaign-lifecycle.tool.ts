import { z } from 'zod';
import { Campaign } from '../../models';
import { PendingActionService } from '../../services/pending-action.service';

export const pauseCampaignInputSchema = z.object({
  campaignId: z.string().describe('The ID of the outreach campaign to pause'),
});

export async function executePauseCampaign(
  input: z.infer<typeof pauseCampaignInputSchema>,
  conversationId: string
) {
  const campaign = await Campaign.findById(input.campaignId).lean();
  if (!campaign) {
    return {
      success: false,
      error: `Campaign ${input.campaignId} not found`,
    };
  }

  const pendingAction = await PendingActionService.createAction({
    conversationId,
    actionType: 'PAUSE_CAMPAIGN',
    payload: {
      campaignId: input.campaignId,
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
        entityId: input.campaignId,
        title: campaign.name,
        action: 'PAUSE_CAMPAIGN',
        description: `Pause all outreach follow-ups for "${campaign.name}"`,
      },
    },
  };
}

export const resumeCampaignInputSchema = z.object({
  campaignId: z.string().describe('The ID of the outreach campaign to resume'),
});

export async function executeResumeCampaign(
  input: z.infer<typeof resumeCampaignInputSchema>,
  conversationId: string
) {
  const campaign = await Campaign.findById(input.campaignId).lean();
  if (!campaign) {
    return {
      success: false,
      error: `Campaign ${input.campaignId} not found`,
    };
  }

  const pendingAction = await PendingActionService.createAction({
    conversationId,
    actionType: 'RESUME_CAMPAIGN',
    payload: {
      campaignId: input.campaignId,
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
        entityId: input.campaignId,
        title: campaign.name,
        action: 'RESUME_CAMPAIGN',
        description: `Resume active outreach follow-ups for "${campaign.name}"`,
      },
    },
  };
}
