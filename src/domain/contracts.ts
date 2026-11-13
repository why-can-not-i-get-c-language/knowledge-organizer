import { z } from 'zod';
import { anchorMatches } from './anchors.ts';
export type { Workspace, WorkspaceCard, WorkspaceRound, WorkspaceAnswer, WorkspaceGroup, WorkspaceDiscussion } from './workspace.ts';

export const MAX_BANK_BYTES = 10 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
export const scannedQuizSchema = z
  .object({
    path: z.string().min(1).max(4096),
    id: z.string().min(1).max(100),
    version: z.string().min(1).max(100),
    title: z.string().min(1).max(20000),
    questionCount: z.number().int().min(1).max(1000),
    size: z.number().int().min(1).max(MAX_BANK_BYTES),
  })
  .strict();
export const quizScanSchema = z
  .object({
    files: z.array(scannedQuizSchema).max(1000),
    partial: z.boolean(),
    cancelled: z.boolean(),
  })
  .strict();
export type ScannedQuiz = z.infer<typeof scannedQuizSchema>;
export type QuizScan = z.infer<typeof quizScanSchema>;
const id = z.string().min(1).max(100).refine(value => value.trim().length > 0, 'ID不能全为空白');
const text = z.string().min(1).max(20000);
export const timestampSchema = z.iso.datetime({ offset: true }).max(40)
  .refine(value => Number.isFinite(Date.parse(value)), '时间无效');
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const questionSchema = z.object({
  id, version: id, type: z.enum(['boolean', 'single', 'multiple']),
  origin: z.enum(['original', 'generated']),
  sourceQuestionNumber: id.optional(), sourceText: text.optional(), source: text.optional(),
  module: id, knowledgePoints: z.array(text).min(1), prompt: text,
  options: z.array(z.object({ id, text }).strict()).min(2).max(20),
  correctAnswer: z.array(id).min(1), explanation: text,
}).strict().superRefine((q, ctx) => {
  const ids = q.options.map(o => o.id);
  if (new Set(ids).size !== ids.length || new Set(q.correctAnswer).size !== q.correctAnswer.length ||
      q.correctAnswer.some(a => !ids.includes(a)) || (q.type !== 'multiple' && q.correctAnswer.length !== 1) ||
      (q.type === 'boolean' && ids.length !== 2) ||
      (q.origin === 'original' && (!q.sourceQuestionNumber || !q.sourceText || !q.source)))
    ctx.addIssue({ code: 'custom', message: '选项、答案引用或原题来源不完整' });
});
export const bankSchema = z.object({
  schemaVersion: z.literal(1), id, version: id, title: text,
  questions: z.array(questionSchema).min(1).max(1000),
}).strict().superRefine((b, ctx) => {
  if (new Set(b.questions.map(q => q.id)).size !== b.questions.length)
    ctx.addIssue({ code: 'custom', message: '题目ID重复' });
  if (new TextEncoder().encode(JSON.stringify(b)).length > MAX_BANK_BYTES)
    ctx.addIssue({ code: 'custom', message: '题集内容超过10MiB' });
});
export type Question = z.infer<typeof questionSchema>;
export type Bank = z.infer<typeof bankSchema>;
export const responseSchema = z.object({
  questionId: id, selectedOptionIds: z.array(id).max(20), confirmed: z.boolean(),
  understood: z.boolean().nullable(),
}).strict();
export type Response = z.infer<typeof responseSchema>;
export const attemptSchema = z.object({
  schemaVersion: z.literal(1), id, revision, phase: z.enum(['answering', 'reviewing', 'completed']),
  bank: bankSchema, responses: z.array(responseSchema).min(1).max(1000), createdAt: timestampSchema,
  gradedAt: timestampSchema.optional(), completedAt: timestampSchema.optional(),
}).strict().superRefine((a, ctx) => {
  const report = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (a.responses.length !== a.bank.questions.length || new Set(a.responses.map(r => r.questionId)).size !== a.responses.length)
    report('作答必须与题目一一对应');
  const byId = new Map(a.bank.questions.map(q => [q.id, q]));
  for (const r of a.responses) {
    const q = byId.get(r.questionId);
    if (!q || new Set(r.selectedOptionIds).size !== r.selectedOptionIds.length ||
      r.selectedOptionIds.some(id => !q.options.some(o => o.id === id)) ||
      (q.type !== 'multiple' && r.selectedOptionIds.length > 1)) {
      report('作答的题目或选项引用无效'); continue;
    }
    if (r.confirmed && !r.selectedOptionIds.length) report('空答案不能确认');
    if (q.type !== 'multiple' && r.confirmed !== (r.selectedOptionIds.length === 1)) report('判断和单选的确认状态无效');
    if (a.phase === 'answering' && r.understood !== null) report('答题阶段不能提前自评');
    if (a.phase !== 'answering' && (!r.confirmed || !r.selectedOptionIds.length)) report('判分后所有答案必须有效且已确认');
    if (a.phase === 'completed' && r.understood === null) report('完成记录不能包含未评价题目');
  }
  if (a.phase === 'answering' && (a.gradedAt !== undefined || a.completedAt !== undefined)) report('答题阶段不能包含判分或完成时间');
  if (a.phase !== 'answering' && a.gradedAt === undefined) report('缺少判分时间');
  if (a.phase === 'reviewing' && a.completedAt !== undefined) report('解析阶段不能包含完成时间');
  if (a.phase === 'completed' && a.completedAt === undefined) report('缺少完成时间');
  if (a.gradedAt && Date.parse(a.gradedAt) < Date.parse(a.createdAt)) report('判分时间早于创建时间');
  if (a.completedAt && a.gradedAt && Date.parse(a.completedAt) < Date.parse(a.gradedAt)) report('完成时间早于判分时间');
});
export type Attempt = z.infer<typeof attemptSchema>;
export type Phase = Attempt['phase'];

export const anchorSchema = z.object({
  bankId: id, bankVersion: id, questionId: id, questionVersion: id,
  field: z.enum(['prompt', 'option', 'explanation']), optionId: id.optional(),
  // 原始字段的零基 UTF-16 范围，结束位置不包含在选区内。
  start: z.number().int().min(0).max(20000), end: z.number().int().min(1).max(20000),
  quote: text, prefix: z.string().max(24), suffix: z.string().max(24), kind: z.enum(['text', 'formula']),
}).strict().superRefine((a, ctx) => {
  if (a.end <= a.start || a.quote.length !== a.end - a.start || (a.field === 'option') !== (a.optionId !== undefined))
    ctx.addIssue({ code: 'custom', message: '选文范围或字段引用无效' });
});
export type Anchor = z.infer<typeof anchorSchema>;
export const annotationSchema = z.object({
  id, attemptId: id, anchor: anchorSchema, note: z.string().max(4000), resolved: z.boolean(),
  createdAt: timestampSchema, updatedAt: timestampSchema,
}).strict().refine(a => Date.parse(a.updatedAt) >= Date.parse(a.createdAt), '标记更新时间早于创建时间');
export type Annotation = z.infer<typeof annotationSchema>;

export const messageSchema = z.object({
  id, role: z.enum(['user', 'assistant']), content: z.string().max(200000),
  status: z.enum(['complete', 'interrupted']), createdAt: timestampSchema,
}).strict().superRefine((m, ctx) => {
  if ((m.role === 'user' && m.status !== 'complete') || (m.status === 'complete' && !m.content.trim()))
    ctx.addIssue({ code: 'custom', message: '用户消息或完整回答不能为空；中断回答须明确标记' });
});
export type Message = z.infer<typeof messageSchema>;
export const conversationSchema = z.object({
  schemaVersion: z.literal(1), id, revision, attemptId: id, questionId: id, annotationId: id.optional(),
  messages: z.array(messageSchema).max(1000), createdAt: timestampSchema, updatedAt: timestampSchema,
}).strict().superRefine((c, ctx) => {
  if (new Set(c.messages.map(m => m.id)).size !== c.messages.length)
    ctx.addIssue({ code: 'custom', message: '消息ID重复' });
  let previous = Date.parse(c.createdAt);
  for (const m of c.messages) {
    const at = Date.parse(m.createdAt);
    if (at < previous || at > Date.parse(c.updatedAt)) ctx.addIssue({ code: 'custom', message: '消息时间与会话不一致' });
    previous = at;
  }
  if (Date.parse(c.updatedAt) < Date.parse(c.createdAt)) ctx.addIssue({ code: 'custom', message: '会话更新时间早于创建时间' });
});
export type Conversation = z.infer<typeof conversationSchema>;

export function annotationMatchesAttempt(mark: Annotation, attempt: Attempt): boolean {
  return mark.attemptId === attempt.id && Date.parse(mark.createdAt) >= Date.parse(attempt.createdAt) &&
    (mark.anchor.field !== 'explanation' || (attempt.gradedAt !== undefined && Date.parse(mark.createdAt) >= Date.parse(attempt.gradedAt))) &&
    anchorMatches(attempt.bank, mark.anchor);
}

export function conversationMatchesAttempt(c: Conversation, attempt: Attempt, mark?: Annotation): boolean {
  return c.attemptId === attempt.id && attempt.bank.questions.some(q => q.id === c.questionId) &&
    Date.parse(c.createdAt) >= Date.parse(attempt.createdAt) &&
    (c.annotationId === undefined || (mark !== undefined && mark.id === c.annotationId &&
      annotationMatchesAttempt(mark, attempt) && mark.anchor.questionId === c.questionId &&
      Date.parse(c.createdAt) >= Date.parse(mark.createdAt)));
}

export const backupSchema = z.object({
  format: z.literal('knowledge-organizer.backup'), schemaVersion: z.literal(1), exportedAt: timestampSchema,
  banks: z.array(bankSchema).max(1000), attempts: z.array(attemptSchema).max(10000),
  annotations: z.array(annotationSchema).max(100000), conversations: z.array(conversationSchema).max(10000),
}).strict().superRefine((b, ctx) => {
  const report = (message: string) => ctx.addIssue({ code: 'custom', message });
  const bankKey = (bank: Bank) => JSON.stringify([bank.id, bank.version]);
  const banks = new Map(b.banks.map(bank => [bankKey(bank), bank]));
  const attempts = new Map(b.attempts.map(a => [a.id, a]));
  const annotations = new Map(b.annotations.map(a => [a.id, a]));
  if (banks.size !== b.banks.length || attempts.size !== b.attempts.length || annotations.size !== b.annotations.length ||
    new Set(b.conversations.map(c => c.id)).size !== b.conversations.length) report('备份包含重复记录ID或题集版本');
  const cutoff = Date.parse(b.exportedAt);
  for (const a of b.attempts) {
    const bank = banks.get(bankKey(a.bank));
    if (!bank || JSON.stringify(bank) !== JSON.stringify(a.bank)) report('作答快照与备份题集内容或版本不一致');
    if (Date.parse(a.createdAt) > cutoff || (a.gradedAt && Date.parse(a.gradedAt) > cutoff) ||
      (a.completedAt && Date.parse(a.completedAt) > cutoff)) report('作答时间晚于导出时间');
  }
  for (const mark of b.annotations) {
    const attempt = attempts.get(mark.attemptId);
    if (!attempt || !annotationMatchesAttempt(mark, attempt)) report('标记引用、时间或原文定位失配');
    if (Date.parse(mark.updatedAt) > cutoff) report('标记时间晚于导出时间');
  }
  for (const c of b.conversations) {
    const attempt = attempts.get(c.attemptId);
    const mark = c.annotationId === undefined ? undefined : annotations.get(c.annotationId);
    if (!attempt || !conversationMatchesAttempt(c, attempt, mark)) report('会话引用、题目或时间失配');
    if (Date.parse(c.updatedAt) > cutoff) report('会话时间晚于导出时间');
  }
});
export type Backup = z.infer<typeof backupSchema>;
export type ErrorCode = 'INVALID_INPUT' | 'INVALID_STATE' | 'INCOMPLETE' | 'VERSION_CONFLICT' |
  'ANCHOR_MISMATCH' | 'SAVE_FAILED' | 'CLIPBOARD_FAILED' | 'NETWORK' | 'AUTH' |
  'BALANCE' | 'RATE_LIMIT' | 'CANCELLED';
export class AppError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.code = code; }
}
