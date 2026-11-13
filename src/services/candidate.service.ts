import { parse } from 'csv-parse/sync';
import mongoose from 'mongoose';
import { Candidate, ICandidate, Job, Message } from '../models';
import { normalizeEmail, normalizeProfileUrl } from '../utils/normalizer';
import { scoringQueue } from '../queues';
import { publishConversationEvent } from './event-bus.service';

export interface CsvUploadResult {
  totalRows: number;
  newCount: number;
  duplicateCount: number;
  enqueuedCount: number;
  message: string;
}

export class CandidateService {
  public static async listCandidatesForJob(
    jobId: string,
    filters?: {
      scoreTier?: 'strong' | 'moderate' | 'weak';
      sourceMode?: 'serper' | 'fixture' | 'csv';
      search?: string;
    }
  ): Promise<ICandidate[]> {
    const jobObjectId = new mongoose.Types.ObjectId(jobId);
    const query: any = { jobId: jobObjectId };

    if (filters?.sourceMode) {
      query.sourceMode = filters.sourceMode;
    }

    if (filters?.scoreTier) {
      if (filters.scoreTier === 'strong') {
        query.score = { $gte: 80 };
      } else if (filters.scoreTier === 'moderate') {
        query.score = { $gte: 60, $lt: 80 };
      } else if (filters.scoreTier === 'weak') {
        query.$or = [{ score: { $lt: 60 } }, { scoreStatus: 'failed' }];
      }
    }

    if (filters?.search && filters.search.trim()) {
      const regex = new RegExp(filters.search.trim(), 'i');
      query.$or = [{ fullName: regex }, { currentTitle: regex }, { skills: regex }];
    }

    return Candidate.find(query).sort({ score: -1, createdAt: -1 });
  }

  public static async processCsvUpload(
    jobId: string,
    fileBuffer: Buffer,
    fileName: string,
    conversationId?: string
  ): Promise<CsvUploadResult> {
    const job = await Job.findById(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // 1. Parse CSV
    let records: Record<string, string>[];
    try {
      records = parse(fileBuffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch (parseErr: any) {
      throw new Error(`CSV Parsing failed: ${parseErr.message}`);
    }

    if (records.length === 0) {
      throw new Error('CSV file is empty');
    }

    if (records.length > 500) {
      throw new Error(`CSV exceeds maximum limit of 500 rows (found ${records.length})`);
    }

    // 2. Validate required headers
    const sample = records[0];
    const keys = Object.keys(sample).map((k) => k.toLowerCase());

    const hasName = keys.some((k) => k === 'fullname' || k === 'name' || k === 'full_name');
    const hasContact = keys.some(
      (k) =>
        k === 'email' ||
        k === 'profileurl' ||
        k === 'profile_url' ||
        k === 'linkedinurl' ||
        k === 'linkedin_url' ||
        k === 'linkedin'
    );

    if (!hasName || !hasContact) {
      throw new Error(
        'Invalid CSV headers. Must contain a name header (fullName or name) and at least one contact identifier (email, profileUrl, or linkedinUrl).'
      );
    }

    // 3. Ingest with batch & database deduplication
    const seenEmailsInBatch = new Set<string>();
    const seenUrlsInBatch = new Set<string>();

    let newCount = 0;
    let duplicateCount = 0;
    const candidatesToScore: string[] = [];

    const jobObjectId = new mongoose.Types.ObjectId(jobId);

    for (const row of records) {
      // Extract normalized row values
      const fullName =
        row.fullName || row.fullname || row.name || row.Name || row['Full Name'] || '';
      const email = row.email || row.Email || null;
      const profileUrl =
        row.profileUrl ||
        row.profileurl ||
        row.linkedinUrl ||
        row.linkedinurl ||
        row.linkedin ||
        row.profile_url ||
        null;
      const currentTitle =
        row.currentTitle || row.currenttitle || row.title || row.Title || row['Current Title'] || '';
      const currentCompany =
        row.currentCompany || row.currentcompany || row.company || row.Company || row['Current Company'] || '';

      let skills: string[] = [];
      const rawSkills = row.skills || row.Skills;
      if (rawSkills) {
        skills = rawSkills
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }

      if (!fullName.trim()) {
        continue;
      }

      const normEmail = normalizeEmail(email);
      const normUrl = normalizeProfileUrl(profileUrl);

      // Within-CSV deduplication check
      if (normEmail && seenEmailsInBatch.has(normEmail)) {
        duplicateCount++;
        continue;
      }
      if (normUrl && seenUrlsInBatch.has(normUrl)) {
        duplicateCount++;
        continue;
      }

      if (normEmail) seenEmailsInBatch.add(normEmail);
      if (normUrl) seenUrlsInBatch.add(normUrl);

      // Database deduplication check
      const orConditions: any[] = [];
      if (normEmail) orConditions.push({ normalizedEmail: normEmail });
      if (normUrl) orConditions.push({ normalizedProfileUrl: normUrl });

      let existing = null;
      if (orConditions.length > 0) {
        existing = await Candidate.findOne({
          jobId: jobObjectId,
          $or: orConditions,
        });
      }

      if (existing) {
        duplicateCount++;
        if (existing.scoreStatus === 'pending') {
          candidatesToScore.push(existing._id.toString());
        }
        continue;
      }

      // Create new candidate
      const newCand = await Candidate.create({
        jobId: jobObjectId,
        fullName: fullName.trim(),
        email: email ? email.trim() : undefined,
        normalizedEmail: normEmail,
        emailStatus: email ? 'valid' : 'missing',
        profileUrl: profileUrl ? profileUrl.trim() : undefined,
        normalizedProfileUrl: normUrl,
        source: 'csv',
        sourceMode: 'csv',
        currentTitle: currentTitle.trim(),
        currentCompany: currentCompany.trim(),
        skills,
        score: null,
        scoreStatus: 'pending',
        scoreMissingInfo: [],
        missingInfo: [],
        status: 'Sourced',
      });

      newCount++;
      candidatesToScore.push(newCand._id.toString());
    }

    // 4. Enqueue candidates to scoring-queue
    for (const cid of candidatesToScore) {
      await scoringQueue.add('score_candidate', {
        jobId,
        candidateId: cid,
        conversationId: conversationId || '',
      });
    }

    const totalProcessed = newCount + duplicateCount;
    const summaryMessage = `Imported ${totalProcessed} candidates from ${fileName} (${newCount} new, ${duplicateCount} skipped as duplicates). Scoring in progress.`;

    // 5. Post summary message to conversation if conversationId was provided
    if (conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
      const convMsg = await Message.create({
        conversationId: new mongoose.Types.ObjectId(conversationId),
        role: 'assistant',
        parts: [{ type: 'text', text: summaryMessage }],
      });

      await publishConversationEvent(conversationId, 'CHAT_PART', {
        messageId: convMsg._id.toString(),
        partIndex: 0,
        part: { type: 'text', text: summaryMessage },
      });
    }

    return {
      totalRows: totalProcessed,
      newCount,
      duplicateCount,
      enqueuedCount: candidatesToScore.length,
      message: summaryMessage,
    };
  }
}
