import { z } from 'zod';
import mongoose from 'mongoose';
import { Candidate, Job } from '../../models';
import { PendingActionService } from '../../services/pending-action.service';

export function generateCandidateOpening(candidate: any, jobTitle: string): string {
  const hasSkills = Array.isArray(candidate.skills) && candidate.skills.length > 0;
  const hasSnippet = candidate.snippet && candidate.snippet.trim().length > 0;

  // Strict Rule: If stored data is too thin (no snippet and no skills), write no personal claim
  if (!hasSkills && !hasSnippet) {
    return '';
  }

  const parts: string[] = [];
  if (candidate.currentTitle && candidate.currentCompany) {
    parts.push(`I noticed your work as a ${candidate.currentTitle} at ${candidate.currentCompany}`);
  } else if (candidate.currentTitle) {
    parts.push(`I came across your experience as a ${candidate.currentTitle}`);
  }

  if (hasSkills) {
    const topSkills = candidate.skills.slice(0, 3).join(', ');
    if (parts.length > 0) {
      parts.push(`, particularly your background in ${topSkills}.`);
    } else {
      parts.push(`I noticed your strong background in ${topSkills}.`);
    }
  } else if (hasSnippet) {
    const cleanSnippet = candidate.snippet.slice(0, 80).trim();
    if (parts.length > 0) {
      parts.push(` (${cleanSnippet}).`);
    } else {
      parts.push(`I came across your profile (${cleanSnippet}).`);
    }
  } else if (parts.length > 0) {
    parts.push('.');
  }

  return parts.join('');
}

export const proposeCampaignInputSchema = z.object({
  jobId: z
    .string()
    .optional()
    .describe('Job ID to create campaign for. If omitted, uses the active job in context.'),
  name: z.string().optional().describe('Name of the campaign'),
  steps: z
    .array(
      z.object({
        stepIndex: z.number().int().min(0).optional(),
        delayDays: z.number().int().min(0).optional(),
        label: z.string().optional(),
        subject: z.string().optional(),
        bodyTemplate: z.string().optional(),
      })
    )
    .optional()
    .describe('Outreach steps sequence (Day 0 initial, Day 3 follow-up, Day 7 final)'),
  candidates: z
    .array(
      z.object({
        candidateId: z.string().optional(),
        fullName: z.string().optional(),
        currentTitle: z.string().optional(),
        currentCompany: z.string().optional(),
        email: z.string().optional(),
        personalOpening: z.string().optional(),
      })
    )
    .optional(),
});

export async function executeProposeCampaign(
  input: z.infer<typeof proposeCampaignInputSchema>,
  conversationId: string
) {
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

  // 3-step default campaign sequence per demo-script.md: Day 0, Day 3, Day 7
  const defaultSteps = [
    {
      stepIndex: 0,
      delayDays: 0,
      label: 'Initial Outreach (Day 0)',
      subject: `Opportunity: ${targetJob.title} at Aironauts Technologies`,
      bodyTemplate: `Hi {{firstName}},\n\n{{personalOpening}}We are currently expanding our core team at Aironauts Technologies and are hiring for a ${targetJob.title}.\n\nGiven your strong expertise with ${skillsString}, I believe this role would be a great mutual fit.\n\nWould you be open to a 15-minute chat this week to discuss what we are building?\n\nBest regards,\nAironauts Recruiting Team`,
    },
    {
      stepIndex: 1,
      delayDays: 3,
      label: 'Follow-Up (Day 3)',
      subject: `Re: Opportunity: ${targetJob.title} at Aironauts Technologies`,
      bodyTemplate: `Hi {{firstName}},\n\nJust following up on my previous note regarding the ${targetJob.title} position at Aironauts Technologies. I know things get busy, so I wanted to ensure this did not slip through the cracks.\n\nLet me know if you might have 10-15 minutes for a quick conversation, or feel free to reply with any initial questions.\n\nBest,\nAironauts Recruiting Team`,
    },
    {
      stepIndex: 2,
      delayDays: 7,
      label: 'Final Follow-Up (Day 7)',
      subject: `Final follow-up: ${targetJob.title} at Aironauts Technologies`,
      bodyTemplate: `Hi {{firstName}},\n\nI wanted to reach out one last time regarding the ${targetJob.title} opportunity. If the timing is not right, no worries at all!\n\nFeel free to keep in touch for future opportunities.\n\nBest regards,\nAironauts Recruiting Team`,
    },
  ];

  const steps = (input.steps && input.steps.length > 0 ? input.steps : defaultSteps).map((s, idx) => ({
    stepIndex: s.stepIndex ?? idx,
    delayDays: s.delayDays ?? (idx === 0 ? 0 : idx === 1 ? 3 : 7),
    label: s.label || (idx === 0 ? 'Initial Outreach (Day 0)' : idx === 1 ? 'Follow-Up (Day 3)' : 'Final Follow-Up (Day 7)'),
    subject: s.subject || `Opportunity: ${targetJob.title} at Aironauts Technologies`,
    bodyTemplate: s.bodyTemplate || defaultSteps[Math.min(idx, 2)].bodyTemplate,
  }));
  const campaignName = input.name || `${targetJob.title} Outreach Campaign`;

  // Build candidate metadata with personal openings
  const candidateMetadata = eligibleCandidates.map((c) => {
    const customOpening = input.candidates?.find(
      (ic) => ic.candidateId === c._id.toString()
    )?.personalOpening;
    return {
      candidateId: c._id.toString(),
      fullName: c.fullName,
      currentTitle: c.currentTitle,
      currentCompany: c.currentCompany,
      email: c.email!,
      skills: c.skills,
      snippet: c.snippet,
      personalOpening:
        customOpening !== undefined
          ? customOpening
          : generateCandidateOpening(c, targetJob!.title),
    };
  });

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
      candidates: candidateMetadata,
      steps,
    },
  });

  const firstCandidate = candidateMetadata[0];

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
        candidates: candidateMetadata,
        steps,
        sampleCandidate: {
          fullName: firstCandidate.fullName,
          currentTitle: firstCandidate.currentTitle,
          currentCompany: firstCandidate.currentCompany,
          personalOpening: firstCandidate.personalOpening,
        },
      },
    },
  };
}
