import { z } from "zod";
import {
  AppError,
  MAX_BACKUP_BYTES,
  timestampSchema,
} from "../domain/contracts.ts";
import type { Workspace } from "../domain/contracts.ts";
import {
  workspaceSchema,
  parseWorkspace,
  migrateLegacyWorkspace,
} from "../domain/workspace.ts";
import { parseBackup } from "../domain/records.ts";

const schema = z
  .object({
    format: z.literal("knowledge-organizer.workspace-backup"),
    schemaVersion: z.literal(1),
    exportedAt: timestampSchema,
    workspace: workspaceSchema,
  })
  .strict();
function size(text: string) {
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES)
    throw new AppError("INVALID_INPUT", "备份超过50MiB，请缩小内容后重试");
}
export function exportWorkspaceBackup(
  workspace: Workspace,
  now: string,
): string {
  const text = JSON.stringify(
    schema.parse({
      format: "knowledge-organizer.workspace-backup",
      schemaVersion: 1,
      exportedAt: now,
      workspace: parseWorkspace(workspace),
    }),
  );
  size(text);
  return text;
}
export function importWorkspaceBackup(text: string, now: string): Workspace {
  size(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AppError("INVALID_INPUT", "备份不是有效JSON，原记录未修改");
  }
  if (
    (value as { format?: unknown } | null)?.format ===
    "knowledge-organizer.backup"
  )
    return migrateLegacyWorkspace(parseBackup(text), now);
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(
      "INVALID_INPUT",
      "备份格式、版本或引用不合法，原记录未修改",
    );
  return result.data.workspace;
}
