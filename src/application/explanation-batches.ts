import type { Annotation, Attempt } from '../domain/contracts.ts';
import { statistics } from '../domain/quiz.ts';
import { buildExplanationRequest } from './export-request.ts';

/** 只在题目之间分批；超长单题单独保留，不截断公式或疑问。 */
export function explanationBatches(attempt: Attempt, marks: Annotation[], scope: 'all' | 'rework', limit = 8000): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1000 || limit > 50000) throw new Error('每批长度须为1000～50000个字符');
  const ids = scope === 'all' ? attempt.bank.questions.map(q => q.id) : statistics(attempt, marks).reworkQuestionIds;
  const result: string[] = [];
  for (const id of ids) {
    const text = buildExplanationRequest(attempt, marks, { questionId: id });
    const last = result.length - 1;
    if (last >= 0 && result[last]!.length + text.length + 2 <= limit) result[last] += '\n\n' + text;
    else result.push(text);
  }
  return result;
}
