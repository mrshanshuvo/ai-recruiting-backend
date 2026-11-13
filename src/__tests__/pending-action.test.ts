import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { app } from '../index.api';
import { connectDB } from '../config/db';
import { connectRedis, redisConnection } from '../config/redis';
import { redisPublisher } from '../services/event-bus.service';
import { Conversation, Job, PendingAction } from '../models';
import { PendingActionService } from '../services/pending-action.service';

describe('PendingAction Service & Confirmation Gate Tests', () => {
  let conv1Id: string;
  let conv2Id: string;

  beforeAll(async () => {
    await connectDB();
    await connectRedis();

    const c1 = await Conversation.create({ title: 'Test Conv 1' });
    const c2 = await Conversation.create({ title: 'Test Conv 2' });
    conv1Id = c1._id.toString();
    conv2Id = c2._id.toString();
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Job.deleteMany({});
    await PendingAction.deleteMany({});
    await mongoose.connection.close();
    redisConnection.disconnect();
    redisPublisher.disconnect();
  });

  it('1. Confirm executes once even if called twice concurrently (atomic findOneAndUpdate)', async () => {
    // Create an action
    const action = await PendingActionService.createAction({
      conversationId: conv1Id,
      actionType: 'CREATE_JOB',
      payload: {
        title: 'Concurrent Senior Engineer',
        mustHaveSkills: ['React', 'TypeScript'],
        location: 'Remote',
      },
    });

    const actionId = action._id.toString();

    // Call confirm concurrently via Supertest
    const [res1, res2] = await Promise.all([
      request(app).post(`/api/actions/${actionId}/confirm`).send({}),
      request(app).post(`/api/actions/${actionId}/confirm`).send({}),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // One must succeed with 200, one must fail with 422 (ACTION_ALREADY_EXECUTED)
    expect(statuses).toEqual([200, 422]);

    const successfulRes = res1.status === 200 ? res1 : res2;
    const failedRes = res1.status === 422 ? res1 : res2;

    expect(successfulRes.body.success).toBe(true);
    expect(successfulRes.body.status).toBe('EXECUTED');
    expect(failedRes.body.success).toBe(false);
    expect(failedRes.body.error.code).toBe('ACTION_ALREADY_EXECUTED');

    // Verify only ONE job was created in MongoDB
    const jobs = await Job.find({ title: 'Concurrent Senior Engineer' });
    expect(jobs.length).toBe(1);
  });

  it('2. Expired action cannot be confirmed (returns 422 and marks EXPIRED in code)', async () => {
    // Create an action expired in the past
    const expiredAction = await PendingActionService.createAction({
      conversationId: conv1Id,
      actionType: 'CREATE_JOB',
      payload: {
        title: 'Expired Role',
        mustHaveSkills: ['Python'],
      },
      expiresAt: new Date(Date.now() - 1000 * 60), // 1 minute ago
    });

    const res = await request(app)
      .post(`/api/actions/${expiredAction._id}/confirm`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('ACTION_EXPIRED');

    // Verify status in DB is now EXPIRED and NOT deleted
    const doc = await PendingAction.findById(expiredAction._id);
    expect(doc).not.toBeNull();
    expect(doc?.status).toBe('EXPIRED');

    // Verify NO job was created
    const job = await Job.findOne({ title: 'Expired Role' });
    expect(job).toBeNull();
  });

  it('3. Cancelled action cannot be confirmed (returns 422)', async () => {
    const action = await PendingActionService.createAction({
      conversationId: conv1Id,
      actionType: 'CREATE_JOB',
      payload: {
        title: 'Cancelled Role',
        mustHaveSkills: ['Go'],
      },
    });

    // Cancel it first
    const cancelRes = await request(app)
      .post(`/api/actions/${action._id}/cancel`)
      .send({ reason: 'Changed mind' });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');

    // Now try to confirm it
    const confirmRes = await request(app)
      .post(`/api/actions/${action._id}/confirm`)
      .send({});

    expect(confirmRes.status).toBe(422);
    expect(confirmRes.body.error.code).toBe('ACTION_CANCELLED');

    // Verify NO job was created
    const job = await Job.findOne({ title: 'Cancelled Role' });
    expect(job).toBeNull();
  });

  it('4. Action from another conversation cannot be confirmed through confirm_action (scoped by conversationId)', async () => {
    const action = await PendingActionService.createAction({
      conversationId: conv1Id, // belongs to conv1
      actionType: 'CREATE_JOB',
      payload: {
        title: 'Cross Conversation Job',
        mustHaveSkills: ['Rust'],
      },
    });

    // Try to confirm providing conv2Id
    await expect(
      PendingActionService.confirmAction(action._id.toString(), conv2Id)
    ).rejects.toThrow('Cannot confirm an action belonging to a different conversation');

    // Verify action is still PENDING and no job created
    const doc = await PendingAction.findById(action._id);
    expect(doc?.status).toBe('PENDING');

    const job = await Job.findOne({ title: 'Cross Conversation Job' });
    expect(job).toBeNull();
  });

  it('5. editedPayload is used when present during confirmation', async () => {
    const action = await PendingActionService.createAction({
      conversationId: conv1Id,
      actionType: 'CREATE_JOB',
      payload: {
        title: 'Original Title',
        mustHaveSkills: ['Java'],
        location: 'New York',
      },
    });

    // Edit payload via PATCH /api/actions/:id/payload
    const patchRes = await request(app)
      .patch(`/api/actions/${action._id}/payload`)
      .send({
        editedPayload: {
          title: 'Updated Senior Java Architect',
          mustHaveSkills: ['Java', 'Spring Boot', 'Kafka'],
          location: 'San Francisco, CA',
        },
      });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.status).toBe('PENDING');

    // Confirm action
    const confirmRes = await request(app)
      .post(`/api/actions/${action._id}/confirm`)
      .send({});

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe('EXECUTED');

    // Verify job in database has EDITED values
    const originalJob = await Job.findOne({ title: 'Original Title' });
    expect(originalJob).toBeNull();

    const editedJob = await Job.findOne({ title: 'Updated Senior Java Architect' });
    expect(editedJob).not.toBeNull();
    expect(editedJob?.mustHaveSkills).toEqual(['Java', 'Spring Boot', 'Kafka']);
    expect(editedJob?.location).toBe('San Francisco, CA');
  });

  it('6. Invalid edited payload returns 422', async () => {
    const action = await PendingActionService.createAction({
      conversationId: conv1Id,
      actionType: 'CREATE_JOB',
      payload: {
        title: 'Valid Job',
        mustHaveSkills: ['React'],
      },
    });

    // Send invalid payload (empty title)
    const patchRes = await request(app)
      .patch(`/api/actions/${action._id}/payload`)
      .send({
        editedPayload: {
          title: '', // invalid: min length 1
        },
      });

    expect(patchRes.status).toBe(422);
    expect(patchRes.body.success).toBe(false);
    expect(patchRes.body.error.code).toBe('VALIDATION_ERROR');

    // Verify action still has original payload and remains PENDING
    const doc = await PendingAction.findById(action._id);
    expect(doc?.status).toBe('PENDING');
    expect((doc?.payload as any).title).toBe('Valid Job');
  });

  it('7. Missing actionId with exactly one active pending action resolves and confirms', async () => {
    // Clear pending actions for conv2Id
    await PendingAction.deleteMany({ conversationId: conv2Id });

    const singleAction = await PendingActionService.createAction({
      conversationId: conv2Id,
      actionType: 'CREATE_JOB',
      payload: {
        title: 'Only Active Role',
        mustHaveSkills: ['Go', 'Kubernetes'],
      },
    });

    const { resolvedId, error } = await PendingActionService.resolveActionId(conv2Id, undefined, 'confirm');
    expect(error).toBeUndefined();
    expect(resolvedId).toBe(singleAction._id.toString());

    // Confirm it
    const confirmResult = await PendingActionService.confirmAction(resolvedId!, conv2Id);
    expect(confirmResult.status).toBe('EXECUTED');
    expect(confirmResult.result.title).toBe('Only Active Role');
  });

  it('8. Missing actionId with multiple active pending actions returns error listing them', async () => {
    // Create conversation with 2 pending actions
    const multiConv = await Conversation.create({ title: 'Multi Actions Conv' });
    const multiConvId = multiConv._id.toString();

    const a1 = await PendingActionService.createAction({
      conversationId: multiConvId,
      actionType: 'CREATE_JOB',
      payload: { title: 'First Role', mustHaveSkills: ['Node.js'] },
    });

    const a2 = await PendingActionService.createAction({
      conversationId: multiConvId,
      actionType: 'CREATE_JOB',
      payload: { title: 'Second Role', mustHaveSkills: ['Python'] },
    });

    const { resolvedId, error } = await PendingActionService.resolveActionId(multiConvId, undefined, 'confirm');
    expect(resolvedId).toBeUndefined();
    expect(error).toBeDefined();
    expect(error).toContain('Multiple pending actions exist');
    expect(error).toContain('First Role');
    expect(error).toContain('Second Role');
    expect(error).toContain('Please specify which one');
  });

  it('9. Missing actionId with zero active pending actions returns clear error', async () => {
    const emptyConv = await Conversation.create({ title: 'Empty Actions Conv' });
    const emptyConvId = emptyConv._id.toString();

    const { resolvedId, error } = await PendingActionService.resolveActionId(emptyConvId, undefined, 'confirm');
    expect(resolvedId).toBeUndefined();
    expect(error).toBe('No active pending action found to confirm in this conversation.');
  });

  it('10. LLM retry: first call forced to fail with 503, retry succeeds', async () => {
    const { executeWithRetry } = await import('../agent/agent.service');

    let attempts = 0;
    const mockModelFn = async (modelName: string) => {
      attempts++;
      if (attempts === 1) {
        const err: any = new Error('This model is currently experiencing high demand. Spikes in demand are usually temporary.');
        err.statusCode = 503;
        throw err;
      }
      return { success: true, model: modelName, attempts };
    };

    const res = await executeWithRetry(mockModelFn, 'test-primary-model', 'test-fallback-model');
    expect(res.success).toBe(true);
    expect(res.attempts).toBe(2);
    expect(res.model).toBe('test-primary-model');
    expect(attempts).toBe(2);
  });
});

