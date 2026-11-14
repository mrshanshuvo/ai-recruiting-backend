import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT } from '../agent/system-prompt';
import { REGISTERED_TOOL_NAMES } from '../agent/agent.service';

/**
 * Extracts tool names quoted as '<name>' where name has snake_case format and is mentioned
 * in an invocation context (e.g. invoke 'foo', call 'foo', or 'foo' tool).
 */
export function extractToolNamesFromPrompt(promptText: string): string[] {
  // Regex matches 'tool_name' patterns where it is explicitly referred to as a tool or action to invoke
  const matches = promptText.match(/'[a-z][a-z0-9_]+'/g) || [];
  const registeredSet = new Set<string>(REGISTERED_TOOL_NAMES);
  
  // Non-tool literals that may appear in quotes (e.g. 'accept', 'reject', 'serper', 'fixture', 'csv')
  const nonToolLiterals = new Set([
    'accept',
    'reject',
    'serper',
    'fixture',
    'csv',
    'candidate_table',
  ]);

  const toolNames = new Set<string>();
  for (const raw of matches) {
    const name = raw.replace(/'/g, '');
    if (!nonToolLiterals.has(name)) {
      toolNames.add(name);
    }
  }

  return Array.from(toolNames);
}

describe('E1: System Prompt Tool Registration Guard', () => {
  it('extracts all tool names mentioned in SYSTEM_PROMPT and verifies every single one is registered', () => {
    const mentionedTools = extractToolNamesFromPrompt(SYSTEM_PROMPT);
    const registeredSet = new Set<string>(REGISTERED_TOOL_NAMES);

    expect(mentionedTools.length).toBeGreaterThan(0);

    const unregisteredMentioned = mentionedTools.filter((t) => !registeredSet.has(t));
    expect(
      unregisteredMentioned,
      `SYSTEM_PROMPT mentions unregistered tool(s): ${unregisteredMentioned.join(', ')}`
    ).toEqual([]);
  });

  it('fails loudly when a simulated prompt mentions an unregistered tool like propose_job_creation', () => {
    const invalidPrompt = `${SYSTEM_PROMPT}\n11. Always invoke 'propose_job_creation' for jobs.`;
    const mentioned = extractToolNamesFromPrompt(invalidPrompt);
    const registeredSet = new Set<string>(REGISTERED_TOOL_NAMES);

    const unregistered = mentioned.filter((t) => !registeredSet.has(t));
    expect(unregistered).toContain('propose_job_creation');
    expect(() => {
      if (unregistered.length > 0) {
        throw new Error(`Unregistered tool mentioned: ${unregistered.join(', ')}`);
      }
    }).toThrowError(/propose_job_creation/);
  });

  it('verifies parse_and_propose_job is registered and mentioned in SYSTEM_PROMPT', () => {
    expect(REGISTERED_TOOL_NAMES).toContain('parse_and_propose_job');
    expect(SYSTEM_PROMPT).toContain("'parse_and_propose_job'");
    expect(SYSTEM_PROMPT).not.toContain('propose_job_creation');
  });

  it('verifies all primary workflow tools are mentioned in SYSTEM_PROMPT', () => {
    const expectedWorkflowTools = [
      'parse_and_propose_job',
      'request_candidate_sourcing',
      'propose_candidate_review',
      'confirm_action',
      'cancel_action',
      'show_candidates',
      'propose_campaign',
      'pause_campaign',
      'resume_campaign',
      'update_candidate_status',
      'send_booking_link',
      'get_job_stats',
    ];

    for (const toolName of expectedWorkflowTools) {
      expect(
        SYSTEM_PROMPT.includes(`'${toolName}'`),
        `Expected SYSTEM_PROMPT to mention registered tool '${toolName}'`
      ).toBe(true);
    }
  });
});
