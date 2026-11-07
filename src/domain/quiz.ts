import { AppError, bankSchema } from './contracts.ts';
import type { Attempt, Bank, Question, Response, Annotation, Anchor } from './contracts.ts';

export function importBank(json: string): Bank {
  if (new TextEncoder().encode(json).length > 10 * 1024 * 1024)
    throw new AppError('INVALID_INPUT', '题目文件超过10MiB，请拆分后导入');
  try { return bankSchema.parse(JSON.parse(json)); }
  catch { throw new AppError('INVALID_INPUT', '题目文件格式、版本或答案引用错误，请检查后重新导入'); }
}
export function createAttempt(bank: Bank, id: string, now: string): Attempt {
  if (!id || !Number.isFinite(Date.parse(now))) throw new AppError('INVALID_INPUT', '作答ID或时间无效');
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
  const q = bank.questions.find(q => q.id === anchor.questionId);
  const value = q && (anchor.field === 'prompt' ? q.prompt : anchor.field === 'explanation' ? q.explanation : q.options.find(o => o.id === anchor.optionId)?.text);
  if (!q || bank.id !== anchor.bankId || bank.version !== anchor.bankVersion || q.version !== anchor.questionVersion ||
      value === undefined || !Number.isInteger(anchor.start) || !Number.isInteger(anchor.end) ||
      anchor.start < 0 || anchor.end <= anchor.start || anchor.end > value.length ||
      value.slice(anchor.start, anchor.end) !== anchor.quote ||
      !value.slice(0, anchor.start).endsWith(anchor.prefix) || !value.slice(anchor.end).startsWith(anchor.suffix))
    throw new AppError('ANCHOR_MISMATCH', '题目版本或选文位置已变化，请重新定位，不会自动贴到其他文字');
}
export function visibleQuestions(a: Attempt) {
  return a.bank.questions.map(({ correctAnswer, explanation, ...q }) => a.phase === 'answering' ? q : { ...q, correctAnswer, explanation });
}
