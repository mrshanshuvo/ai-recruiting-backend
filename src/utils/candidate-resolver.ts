import mongoose from 'mongoose';
import { Candidate, ICandidate } from '../models';

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface CandidateResolutionResult {
  success: boolean;
  candidate?: ICandidate;
  error?: string;
  ambiguousCandidates?: string[];
}

/**
 * Resolves a candidate by name query within a specific job:
 * 1. Checks exact full name match (case-insensitive) first.
 * 2. If no exact match, checks partial name substring match.
 *    - If exactly one partial match is found, returns that candidate.
 *    - If multiple partial matches are found, refuses to guess and returns an error with the candidate names.
 *    - If zero matches are found, returns a not-found error.
 */
export async function resolveCandidateByName(
  jobId: string | mongoose.Types.ObjectId,
  nameQuery: string
): Promise<CandidateResolutionResult> {
  const trimmed = nameQuery.trim();
  if (!trimmed) {
    return {
      success: false,
      error: 'Candidate name cannot be empty',
    };
  }

  const jobObjectId = typeof jobId === 'string' ? new mongoose.Types.ObjectId(jobId) : jobId;

  // 1. Exact match (case-insensitive)
  const exactCandidates = await Candidate.find({
    jobId: jobObjectId,
    fullName: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, 'i') },
  });

  if (exactCandidates.length === 1) {
    return {
      success: true,
      candidate: exactCandidates[0],
    };
  }

  // 2. Partial substring match (case-insensitive)
  const partialCandidates = await Candidate.find({
    jobId: jobObjectId,
    fullName: { $regex: new RegExp(escapeRegex(trimmed), 'i') },
  });

  if (partialCandidates.length === 1) {
    return {
      success: true,
      candidate: partialCandidates[0],
    };
  }

  if (partialCandidates.length > 1) {
    const matchingNames = partialCandidates.map((c) => c.fullName);
    return {
      success: false,
      error: `Name "${nameQuery}" is ambiguous and matches multiple candidates: ${matchingNames.join(', ')}. Please clarify which candidate you mean.`,
      ambiguousCandidates: matchingNames,
    };
  }

  return {
    success: false,
    error: `Candidate "${nameQuery}" not found.`,
    ambiguousCandidates: [],
  };
}

