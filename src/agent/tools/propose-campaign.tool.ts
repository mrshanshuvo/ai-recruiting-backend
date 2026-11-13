import { z } from 'zod';
import mongoose from 'mongoose';
import { Candidate, Job } from '../../models';
import { PendingActionService } from '../../services/pending-action.service';

export const proposeCampaignInputSchema = z.object({
  jobId: z
    .string()
    .optional()
    .describe('Job ID to create campaign for. If omitted, uses the active job in context.'),
  name: z.string().optional().describe('Name of the campaign'),
  steps: z
    .array(
      z.object({
        stepIndex: z.number().int().min(0),
        delayDays: z.number().int().min(0),
        label: z.string().optional(),
        subject: z.string(),
        bodyTemplate: z.string(),
      })
    )
    .optional()
    .describe('Outreach steps sequence (e.g. Day 0 initial, Day 3 follow-up)'),
});

export async function executeProposeCampaign(
  input: z.infer<typeof proposeCampaignInputSchema>,
  conversationId: string
) {
  console.log('[executeProposeCampaign entry]', input, conversationId);
  let targetJob = null;

  if (input.jobId && mongoose.Types.ObjectId.isValid(input.jobId)) {
    targetJob = await Job.findById(input.jobId).lean();
  }

  if (!targetJob) {
    targetJob = await Job.findOne().sort({ createdAt: -1 }).lean();
  }

  if (!targetJob) {
    return {
      success: false,
      error: 'No active job found to propose an outreach campaign for.',
    };
  }

  // Enrollment rule: strictly restricted to Accepted candidates with valid emails per ADR-0004 & DEC-06
  const eligibleCandidates = await Candidate.find({
    jobId: targetJob._id,
    status: 'Accepted',
    email: { $exists: true, $ne: null },
    emailStatus: 'valid',
  }).lean();

  if (eligibleCandidates.length === 0) {
    return {
      success: false,
      error: `No Accepted candidates with valid emails found for "${targetJob.title}". Please accept candidates with valid email addresses before proposing an outreach campaign.`,
    };
  }

  const skillsString = (targetJob.mustHaveSkills || []).slice(0, 3).join(', ') || 'modern software engineering';

  const defaultSteps = [
    {
      stepIndex: 0,
      delayDays: 0,
      label: 'Initial Outreach (Day 0)',
      subject: `Opportunity: ${targetJob.title} at Aironauts Technologies`,
      bodyTemplate: `Hi {{firstName}},\n\nI came across your background as a {{currentTitle}} at {{companyName}} and was impressed by your work. We are currently expanding our core team at Aironauts Technologies and are hiring for a ${targetJob.title}.\n\nGiven your strong expertise with ${skillsString}, I believe this role would be a great mutual fit.\n\nWould you be open to a 15-minute chat this week to discuss what we are building?\n\nBest regards,\nAironauts Recruiting Team`,
    },
    {
      stepIndex: 1,
      delayDays: 3,
      label: 'Follow-Up (Day 3)',
      subject: `Re: Opportunity: ${targetJob.title} at Aironauts Technologies`,
      bodyTemplate: `Hi {{firstName}},\n\nJust following up on my previous note regarding the ${targetJob.title} position at Aironauts Technologies. I know things get busy, so I wanted to ensure this did not slip through the cracks.\n\nLet me know if you might have 10-15 minutes for a quick conversation, or feel free to reply with any initial questions.\n\nBest,\nAironauts Recruiting Team`,
    },
  ];

  const steps = input.steps && input.steps.length > 0 ? input.steps : defaultSteps;
  const campaignName = input.name || `${targetJob.title} Outreach Campaign`;

  // Create gated PendingAction per ADR-0004
  const pendingAction = await PendingActionService.createAction({
    conversationId,
    actionType: 'SEND_CAMPAIGN',
    payload: {
      jobId: targetJob._id.toString(),
      jobTitle: targetJob.title,
      name: campaignName,
      recipientCount: eligibleCandidates.length,
      candidateIds: eligibleCandidates.map((c) => c._id.toString()),
      candidateNames: eligibleCandidates.map((c) => c.fullName),
      steps,
    },
  });

  const firstCandidate = eligibleCandidates[0];

  return {
    success: true,
    message: `I prepared this, please confirm. I created an outreach campaign proposal for "${targetJob.title}" targeting ${eligibleCandidates.length} accepted candidate(s) with a ${steps.length}-step sequence.`,
    card: {
      cardType: 'campaign_preview',
      actionId: pendingAction._id.toString(),
      status: 'pending',
      payload: {
        jobId: targetJob._id.toString(),
        jobTitle: targetJob.title,
        name: campaignName,
        recipientCount: eligibleCandidates.length,
        candidateIds: eligibleCandidates.map((c) => c._id.toString()),
        candidateNames: eligibleCandidates.map((c) => c.fullName),
        steps,
        sampleCandidate: {
          fullName: firstCandidate.fullName,
          currentTitle: firstCandidate.currentTitle,
          currentCompany: firstCandidate.currentCompany,
        },
      },
    },
  };
}
