import type { z } from 'zod';
import {
  AppError, MAX_BACKUP_BYTES, annotationSchema, attemptSchema, backupSchema, conversationSchema,
  annotationMatchesAttempt, conversationMatchesAttempt,
} from './contracts.ts';
import type { Annotation, Attempt, Backup, Conversation } from './contracts.ts';

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('INVALID_INPUT', `${label}格式、版本、时间或引用不合法，未修改现有记录`);
  return result.data;
}

export function parseAttempt(value: unknown): Attempt { return parse(attemptSchema, value, '作答记录'); }
export function parseAnnotation(value: unknown, attempt: Attempt): Annotation {
  const mark = parse(annotationSchema, value, '疑问标记');
  if (!annotationMatchesAttempt(mark, attempt)) throw new AppError('ANCHOR_MISMATCH', '标记的作答、版本、时间或原文已失配，请重新定位');
  return mark;
}
export function parseConversation(value: unknown, attempt: Attempt, mark?: Annotation): Conversation {
  const conversation = parse(conversationSchema, value, '问答记录');
  if (!conversationMatchesAttempt(conversation, attempt, mark))
    throw new AppError('INVALID_INPUT', '会话与作答、题目或疑问不对应，未合并其他会话');
  return conversation;
}

function requireRevision(previous: number, next: number, expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected !== previous || next !== previous)
    throw new AppError('VERSION_CONFLICT', '记录已更新，请重新读取后再保存，不会覆盖现有内容');
  if (previous === Number.MAX_SAFE_INTEGER) throw new AppError('VERSION_CONFLICT', '记录版本已达上限，请先导出备份');
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameIds = (a: string[], b: string[]) => same([...a].sort(), [...b].sort());

/** 存储事务必须用磁盘现值调用本校验，再写入 revision+1；本函数不保存。 */
export function validateAttemptUpdate(previous: Attempt, next: Attempt, expectedRevision: number): void {
  const before = parseAttempt(previous), after = parseAttempt(next);
  requireRevision(before.revision, after.revision, expectedRevision);
  if (before.id !== after.id || before.createdAt !== after.createdAt || !same(before.bank, after.bank))
    throw new AppError('VERSION_CONFLICT', '不能改写作答身份或题集快照，请新建作答');
  const allowed = before.phase === after.phase || (before.phase === 'answering' && after.phase === 'reviewing') ||
    (before.phase === 'reviewing' && after.phase === 'completed');
  if (!allowed) throw new AppError('INVALID_STATE', '不能跳过解析阶段或回退作答阶段');
  if (before.phase === 'answering' && after.phase === 'reviewing' && after.responses.some(r => r.understood !== null))
    throw new AppError('INVALID_STATE', '首次判分不能同时伪造解析后的理解自评');
  if (before.phase !== 'answering') {
    const responses = new Map(after.responses.map(r => [r.questionId, r]));
    if (before.gradedAt !== after.gradedAt || before.responses.some(r => {
      const nextResponse = responses.get(r.questionId)!;
      return r.confirmed !== nextResponse.confirmed || !sameIds(r.selectedOptionIds, nextResponse.selectedOptionIds);
    })) throw new AppError('INVALID_STATE', '判分后答案与判分时间已锁定');
  }
  if (before.phase === 'completed' && !same(before, after))
    throw new AppError('INVALID_STATE', '已完成作答只读，请创建新的练习记录');
}

/** 已完成消息不改写；仅最后一条中断回答允许续存扩展文本。 */
export function validateConversationUpdate(previous: Conversation, next: Conversation, expectedRevision: number): void {
  const before = parse(conversationSchema, previous, '问答记录'), after = parse(conversationSchema, next, '问答记录');
  requireRevision(before.revision, after.revision, expectedRevision);
  if (before.id !== after.id || before.attemptId !== after.attemptId || before.questionId !== after.questionId ||
    before.annotationId !== after.annotationId || before.createdAt !== after.createdAt)
    throw new AppError('VERSION_CONFLICT', '会话归属不能更改，请新建会话');
  if (Date.parse(after.updatedAt) < Date.parse(before.updatedAt) || after.messages.length < before.messages.length)
    throw new AppError('INVALID_STATE', '不能用旧会话覆盖新消息');
  for (let i = 0; i < before.messages.length; i++) {
    const old = before.messages[i]!, current = after.messages[i]!;
    if (same(old, current)) continue;
    const extend = i === before.messages.length - 1 && old.role === 'assistant' && old.status === 'interrupted' &&
      current.id === old.id && current.role === old.role && current.createdAt === old.createdAt && current.content.startsWith(old.content);
    if (!extend) throw new AppError('INVALID_STATE', '已保存消息不能被替换或截断');
  }
}

export function parseBackup(json: string): Backup {
  if (typeof json !== 'string' || json.length > MAX_BACKUP_BYTES || new TextEncoder().encode(json).length > MAX_BACKUP_BYTES)
    throw new AppError('INVALID_INPUT', '备份文件超过50MiB或不是JSON文本，原有数据未修改');
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new AppError('INVALID_INPUT', '备份不是有效JSON，原有数据未修改'); }
  // 首版只接受明确的 v1 格式；不猜测或静默迁移旧版和未来版本。
  return parse(backupSchema, value, '备份');
}

export function serializeBackup(value: Backup): string {
  const checked = parse(backupSchema, value, '备份');
  const json = JSON.stringify(checked);
  if (new TextEncoder().encode(json).length > MAX_BACKUP_BYTES)
    throw new AppError('INVALID_INPUT', '备份内容超过50MiB，请缩小导出范围');
  return json;
}
