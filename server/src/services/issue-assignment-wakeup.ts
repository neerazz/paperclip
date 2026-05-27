import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

type IssueAssignmentWakeDecisionInput = {
  issue: { assigneeAgentId: string | null; status: string };
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  requestedByRunId?: string | null;
};

type IssueAssignmentWakeSkipReason =
  | "no_agent_assignee"
  | "assigned_backlog"
  | "self_assignment_in_active_run";

export function describeIssueAssignmentWakeup(input: IssueAssignmentWakeDecisionInput): {
  shouldWake: boolean;
  skipReason: IssueAssignmentWakeSkipReason | null;
} {
  if (!input.issue.assigneeAgentId) {
    return { shouldWake: false, skipReason: "no_agent_assignee" };
  }
  if (input.issue.status === "backlog") {
    return { shouldWake: false, skipReason: "assigned_backlog" };
  }
  if (
    input.requestedByActorType === "agent" &&
    input.requestedByRunId &&
    input.requestedByActorId &&
    input.requestedByActorId === input.issue.assigneeAgentId
  ) {
    return { shouldWake: false, skipReason: "self_assignment_in_active_run" };
  }
  return { shouldWake: true, skipReason: null };
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  requestedByRunId?: string | null;
  rethrowOnError?: boolean;
}) {
  const decision = describeIssueAssignmentWakeup({
    issue: input.issue,
    requestedByActorType: input.requestedByActorType,
    requestedByActorId: input.requestedByActorId,
    requestedByRunId: input.requestedByRunId,
  });
  if (!decision.shouldWake) return;

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId!, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: { issueId: input.issue.id, mutation: input.mutation },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: { issueId: input.issue.id, source: input.contextSource },
    })
    .catch((err) => {
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}
