import { and, eq, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, routines, routineTriggers } from "@paperclipai/db";

export async function hasActiveRoutineBackedContinuationPath(
  db: Db,
  input: { companyId: string; issueId: string },
) {
  const row = await db
    .select({ id: routines.id })
    .from(routines)
    .leftJoin(
      routineTriggers,
      and(
        eq(routineTriggers.companyId, input.companyId),
        eq(routineTriggers.routineId, routines.id),
        eq(routineTriggers.enabled, true),
      ),
    )
    .leftJoin(
      issues,
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.originKind, "routine_execution"),
        sql`${issues.originId} = ${routines.id}::text`,
        isNull(issues.hiddenAt),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .where(
      and(
        eq(routines.companyId, input.companyId),
        eq(routines.parentIssueId, input.issueId),
        eq(routines.status, "active"),
        or(isNotNull(routineTriggers.id), isNotNull(issues.id)),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return Boolean(row);
}
