import { z } from 'zod';
import { fetchSafeJdUrl } from '../../services/safe-fetch.service';
import { extractJobFromText } from '../job-extractor';
import { PendingActionService } from '../../services/pending-action.service';

import { z } from 'zod';
import { fetchSafeJdUrl } from '../../services/safe-fetch.service';
import { extractJobFromText } from '../job-extractor';
import { PendingActionService } from '../../services/pending-action.service';

export const parseAndProposeJobInputSchema = z.object({
  rawTextOrUrl: z.string().optional().describe('The raw text of the Job Description or a public HTTP/HTTPS URL'),
  title: z.string().optional().describe('Job title, e.g. Senior Frontend Engineer'),
  mustHaveSkills: z.array(z.string()).optional().describe('Mandatory skills required for the role'),
  niceToHaveSkills: z.array(z.string()).optional().describe('Optional or bonus skills'),
  seniority: z.string().optional().describe('Seniority level, e.g. Senior, Lead, Mid'),
  location: z.string().optional().describe('Job location, e.g. San Francisco, CA'),
  salaryRange: z
    .object({
      min: z.number().optional().describe('Minimum annual base salary'),
      max: z.number().optional().describe('Maximum annual base salary'),
      currency: z.string().default('USD'),
    })
    .optional(),
  remotePolicy: z.enum(['Remote', 'Hybrid', 'On-site']).optional(),
});

export async function executeParseAndProposeJob(
  input: z.infer<typeof parseAndProposeJobInputSchema>,
  conversationId: string
) {
  let title = input.title;
  let mustHaveSkills = input.mustHaveSkills || [];
  let niceToHaveSkills = input.niceToHaveSkills || [];
  let seniority = input.seniority;
  let location = input.location;
  let salaryRange = input.salaryRange;
  let remotePolicy = input.remotePolicy;
  let rawDescription = input.rawTextOrUrl?.slice(0, 5000) || '';

  // If title was not provided directly by the LLM in tool arguments, extract from rawTextOrUrl
  if (!title && input.rawTextOrUrl) {
    let text = input.rawTextOrUrl.trim();

    // If input is a URL, fetch with safe SSRF protections
    if (text.startsWith('http://') || text.startsWith('https://')) {
      try {
        text = await fetchSafeJdUrl(text);
      } catch (err) {
        return {
          success: false,
          error: `Could not safely fetch URL: ${err instanceof Error ? err.message : String(err)}. Please paste the JD text directly.`,
        };
      }
    }

    rawDescription = text.slice(0, 5000);

    // Extract structured attributes via Gemini
    const extracted = await extractJobFromText(text, conversationId);
    title = extracted.title;
    mustHaveSkills = extracted.mustHaveSkills;
    niceToHaveSkills = extracted.niceToHaveSkills;
    seniority = extracted.seniority;
    location = extracted.location;
    salaryRange = extracted.salaryRange;
    remotePolicy = extracted.remotePolicy;
  }

  const payload = {
    title: title || 'Untitled Job',
    rawDescription,
    mustHaveSkills,
    niceToHaveSkills,
    seniority,
    location,
    salaryRange,
    remotePolicy,
  };

  // Create PendingAction for Confirmation Gate
  const pendingAction = await PendingActionService.createAction({
    conversationId,
    actionType: 'CREATE_JOB',
    payload,
    description: `Create Job: ${payload.title}`,
  });

  return {
    success: true,
    message: 'I prepared this, please confirm.',
    card: {
      cardType: 'job_confirmation',
      actionId: pendingAction._id.toString(),
      status: 'pending',
      payload,
    },
  };
}

