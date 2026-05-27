import { describe, expect, it } from "vitest";
import { describeIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

describe("describeIssueAssignmentWakeup", () => {
  it("wakes for board-created assigned work", () => {
    expect(
      describeIssueAssignmentWakeup({
        issue: {
          assigneeAgentId: "agent-1",
          status: "todo",
        },
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        requestedByRunId: null,
      }),
    ).toEqual({
      shouldWake: true,
      skipReason: null,
    });
  });

  it("skips agent self-assignment when the actor has an active run id", () => {
    expect(
      describeIssueAssignmentWakeup({
        issue: {
          assigneeAgentId: "agent-1",
          status: "todo",
        },
        requestedByActorType: "agent",
        requestedByActorId: "agent-1",
        requestedByRunId: "run-1",
      }),
    ).toEqual({
      shouldWake: false,
      skipReason: "self_assignment_in_active_run",
    });
  });

  it("still wakes for self-assignment when the run id is missing", () => {
    expect(
      describeIssueAssignmentWakeup({
        issue: {
          assigneeAgentId: "agent-1",
          status: "todo",
        },
        requestedByActorType: "agent",
        requestedByActorId: "agent-1",
        requestedByRunId: null,
      }),
    ).toEqual({
      shouldWake: true,
      skipReason: null,
    });
  });
});
