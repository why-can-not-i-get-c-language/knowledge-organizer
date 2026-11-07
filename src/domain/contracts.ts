import { z } from 'zod';

const id = z.string().min(1).max(100);
const text = z.string().min(1).max(20000);
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
});
export type Question = z.infer<typeof questionSchema>;
export type Bank = z.infer<typeof bankSchema>;
export type Phase = 'answering' | 'reviewing' | 'completed';
export interface Response {
  questionId: string; selectedOptionIds: string[]; confirmed: boolean;
  understood: boolean | null;
}
export interface Attempt {
  schemaVersion: 1; id: string; revision: number; phase: Phase;
  bank: Bank; responses: Response[]; createdAt: string;
  gradedAt?: string; completedAt?: string;
}
export interface Anchor {
  bankId: string; bankVersion: string; questionId: string; questionVersion: string;
  field: 'prompt' | 'option' | 'explanation'; optionId?: string;
  // 原始字段字符串的 UTF-16 偏移，结束位置不包含在选区内；不能使用 DOM 或屏幕坐标。
  start: number; end: number; quote: string; prefix: string; suffix: string;
  kind: 'text' | 'formula';
}
export interface Annotation {
  id: string; attemptId: string; anchor: Anchor; note: string;
  resolved: boolean; createdAt: string; updatedAt: string;
}
export type ErrorCode = 'INVALID_INPUT' | 'INVALID_STATE' | 'INCOMPLETE' | 'VERSION_CONFLICT' |
  'ANCHOR_MISMATCH' | 'SAVE_FAILED' | 'CLIPBOARD_FAILED' | 'NETWORK' | 'AUTH' |
  'BALANCE' | 'RATE_LIMIT' | 'CANCELLED';
export class AppError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.code = code; }
}
