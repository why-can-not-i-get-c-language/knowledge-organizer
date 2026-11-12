import { AppError, MAX_BANK_BYTES, anchorSchema, bankSchema, timestampSchema } from './contracts.ts';
import { anchorMatches } from './anchors.ts';
import type { Attempt, Bank, Question, Response, Annotation, Anchor } from './contracts.ts';

export function importBank(json: string): Bank {
  if (typeof json !== 'string' || json.length > MAX_BANK_BYTES || new TextEncoder().encode(json).length > MAX_BANK_BYTES)
    throw new AppError('INVALID_INPUT', '题目文件超过10MiB，请拆分后导入');
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new AppError('INVALID_INPUT', '题目文件不是有效JSON，请检查文件后重新导入'); }
  const parsed = bankSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new AppError('INVALID_INPUT', `题目文件 ${issue.path.join('.') || '根对象'}：${issue.message}。请检查后重新导入`);
  }
  return parsed.data;
}
export function createAttempt(bank: Bank, id: string, now: string): Attempt {
  if (!id.trim() || id.length > 100 || !timestampSchema.safeParse(now).success) throw new AppError('INVALID_INPUT', '作答ID或时间无效');
  return { schemaVersion: 1, id, revision: 0, phase: 'answering', bank: bankSchema.parse(bank),
    responses: bank.questions.map(q => ({ questionId: q.id, selectedOptionIds: [], confirmed: false, understood: null })), createdAt: now };
}
const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
export const answerValidators = {
  boolean: (ids: string[]) => ids.length === 1,
  single: (ids: string[]) => ids.length === 1,
  multiple: (ids: string[]) => ids.length > 0,
};
export const scoringPolicies = { exact: (selected: string[], correct: string[]) => Number(same(selected, correct)) };
function valid(q: Question, r: Response): boolean {
  return r.confirmed && answerValidators[q.type](r.selectedOptionIds) &&
    new Set(r.selectedOptionIds).size === r.selectedOptionIds.length &&
    r.selectedOptionIds.every(id => q.options.some(o => o.id === id));
}
function requirePhase(a: Attempt, phase: Attempt['phase']) {
  if (a.phase !== phase) throw new AppError('INVALID_STATE', '当前阶段不允许此操作');
}
export function selectAnswer(a: Attempt, questionId: string, ids: string[], confirm = false): Attempt {
  requirePhase(a, 'answering');
  const q = a.bank.questions.find(q => q.id === questionId);
  if (!q || new Set(ids).size !== ids.length || ids.some(id => !q.options.some(o => o.id === id)) ||
    (q.type !== 'multiple' && ids.length > 1) || (confirm && ids.length === 0))
    throw new AppError('INVALID_INPUT', '所选答案无效');
  return { ...a, responses: a.responses.map(r => r.questionId !== questionId ? r :
    { questionId, selectedOptionIds: [...ids], confirmed: ids.length > 0 && (q.type !== 'multiple' || confirm), understood: null }) };
}
export function submitAnswers(a: Attempt, now: string): Attempt {
  requirePhase(a, 'answering');
  if (!timestampSchema.safeParse(now).success || Date.parse(now) < Date.parse(a.createdAt))
    throw new AppError('INVALID_INPUT', '判分时间无效或早于创建时间');
  if (a.bank.questions.some(q => !a.responses.some(r => r.questionId === q.id && valid(q, r))))
    throw new AppError('INCOMPLETE', '请完成全部题目，多选题须确认答案');
  return { ...a, phase: 'reviewing', gradedAt: now };
}
export function assessUnderstanding(a: Attempt, questionId: string, understood: boolean): Attempt {
  requirePhase(a, 'reviewing');
  if (!a.responses.some(r => r.questionId === questionId)) throw new AppError('INVALID_INPUT', '题目不存在');
  return { ...a, responses: a.responses.map(r => r.questionId === questionId ? { ...r, understood } : r) };
}
export function completeAttempt(a: Attempt, now: string): Attempt {
  requirePhase(a, 'reviewing');
  if (!timestampSchema.safeParse(now).success || !a.gradedAt || Date.parse(now) < Date.parse(a.gradedAt))
    throw new AppError('INVALID_INPUT', '完成时间无效或早于判分时间');
  if (a.responses.some(r => r.understood === null)) throw new AppError('INCOMPLETE', '请先完成解析后的逐题理解自评');
  return { ...a, phase: 'completed', completedAt: now };
}
export function statistics(a: Attempt, marks: Annotation[] = []) {
  if (a.phase === 'answering') throw new AppError('INVALID_STATE', '尚未提交答案，不能查看成绩');
  const rows = a.bank.questions.map(q => {
    const r = a.responses.find(r => r.questionId === q.id)!;
    return { questionId: q.id, module: q.module, correct: scoringPolicies.exact(r.selectedOptionIds, q.correctAnswer) === 1,
      understood: r.understood, hasDoubt: marks.some(m => m.attemptId === a.id && m.anchor.questionId === q.id && !m.resolved) };
  });
  const aggregate = (xs: typeof rows) => ({ total: xs.length, correct: xs.filter(r => r.correct).length,
    accuracy: xs.filter(r => r.correct).length / xs.length });
  return { ...aggregate(rows), rows, modules: Object.fromEntries([...new Set(rows.map(r => r.module))].map(m => [m, aggregate(rows.filter(r => r.module === m))])),
    understandingRate: rows.some(r => r.understood === null) ? null : rows.filter(r => r.understood).length / rows.length,
    reworkQuestionIds: rows.filter(r => !r.correct || r.understood === false || r.hasDoubt).map(r => r.questionId) };
}
export function validateAnchor(bank: Bank, anchor: Anchor): void {
  const parsed = anchorSchema.safeParse(anchor);
  if (!parsed.success || !anchorMatches(bank, parsed.data))
    throw new AppError('ANCHOR_MISMATCH', '题目版本或选文位置已变化，请重新定位，不会自动贴到其他文字');
}
export function visibleQuestions(a: Attempt) {
  return a.bank.questions.map(({ correctAnswer, explanation, ...q }) => a.phase === 'answering' ? q : { ...q, correctAnswer, explanation });
}
