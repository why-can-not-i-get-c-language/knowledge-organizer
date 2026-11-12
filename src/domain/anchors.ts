import type { Anchor, Bank } from './contracts.ts';
import { splitSource } from './source.ts';

export function anchorMatches(bank: Bank, anchor: Anchor): boolean {
  const q = bank.questions.find(q => q.id === anchor.questionId);
  const value = q && (anchor.field === 'prompt' ? q.prompt : anchor.field === 'explanation' ? q.explanation :
    q.options.find(o => o.id === anchor.optionId)?.text);
  if (!q || bank.id !== anchor.bankId || bank.version !== anchor.bankVersion || q.version !== anchor.questionVersion ||
    value === undefined || anchor.start < 0 || anchor.end > value.length || anchor.end <= anchor.start ||
    value.slice(anchor.start, anchor.end) !== anchor.quote ||
    !value.slice(0, anchor.start).endsWith(anchor.prefix) || !value.slice(anchor.end).startsWith(anchor.suffix)) return false;
  const splitsSurrogate = (at: number) => at > 0 && at < value.length &&
    /[\uD800-\uDBFF]/.test(value[at - 1]!) && /[\uDC00-\uDFFF]/.test(value[at]!);
  if (splitsSurrogate(anchor.start) || splitsSurrogate(anchor.end)) return false;
  const formulas = splitSource(value).filter(s => s.formula);
  if (formulas.some(s => (anchor.start > s.start && anchor.start < s.end) ||
    (anchor.end > s.start && anchor.end < s.end))) return false;
  return anchor.kind !== 'formula' || formulas.some(s => s.start === anchor.start && s.end === anchor.end);
}
