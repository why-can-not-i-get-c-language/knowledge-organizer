import katex from 'katex';
import type { Anchor, Bank } from '../domain/contracts.ts';
import { validateAnchor } from '../domain/quiz.ts';
import { splitSource } from '../domain/source.ts';
import type { SourceSegment } from '../domain/source.ts';

export interface FieldRef {
  questionId: string;
  field: Anchor['field'];
  optionId?: string;
}
export interface SourceField {
  element: HTMLElement;
  ref: FieldRef;
  source: string;
  segments: SourceSegment[];
}

export function createField(source: string, ref: FieldRef): SourceField {
  const element = document.createElement('div');
  element.className = 'source-field';
  return { element, source, ref, segments: splitSource(source) };
}

export function paintField(field: SourceField, anchors: Anchor[], onFormula: (start: number, end: number) => void): void {
  const fragment = document.createDocumentFragment();
  const matches = anchors.filter(a => a.questionId === field.ref.questionId && a.field === field.ref.field && a.optionId === field.ref.optionId);
  for (const segment of field.segments) {
    if (segment.formula) {
      const wrapper = document.createElement('span');
      wrapper.className = `formula${segment.display ? ' display' : ''}`;
      const math = document.createElement('span');
      math.dataset.start = String(segment.start);
      math.dataset.end = String(segment.end);
      math.dataset.formula = 'true';
      math.className = 'math-source';
      if (matches.some(a => a.start < segment.end && a.end > segment.start)) math.classList.add('highlight');
      const raw = field.source.slice(segment.start, segment.end);
      const delimiter = raw.startsWith('$$') || raw.startsWith('\\') ? 2 : 1;
      try {
        katex.render(raw.slice(delimiter, -delimiter), math, {
          displayMode: segment.display, throwOnError: true, trust: false,
          strict: 'error', maxExpand: 500, maxSize: 10,
        });
      } catch {
        math.textContent = raw;
        math.classList.add('math-error');
        math.title = '公式无法排版，当前显示原文；仍可整条标记';
      }
      const button = document.createElement('button');
      button.className = 'formula-action';
      button.textContent = '标记整式';
      button.type = 'button';
      button.setAttribute('aria-label', `标记整条公式 ${raw}`);
      button.addEventListener('click', () => onFormula(segment.start, segment.end));
      wrapper.append(math, button);
      fragment.append(wrapper);
    } else {
      const edges = [...new Set([segment.start, segment.end, ...matches.flatMap(a => [a.start, a.end])])]
        .filter(n => n >= segment.start && n <= segment.end).sort((a, b) => a - b);
      for (let i = 0; i < edges.length - 1; i++) {
        const start = edges[i]!, end = edges[i + 1]!;
        const span = document.createElement('span');
        span.dataset.start = String(start);
        span.dataset.end = String(end);
        span.textContent = field.source.slice(start, end);
        if (matches.some(a => a.start < end && a.end > start)) span.className = 'highlight';
        fragment.append(span);
      }
    }
  }
  field.element.replaceChildren(fragment);
}

// DOM文字偏移逐段映射回原字段，公式子树按原子范围吸附，不使用可见文字搜索。
function sourceOffset(field: SourceField, node: Node, offset: number, end: boolean): number {
  const point = document.createRange();
  point.setStart(node, offset);
  point.collapse(true);
  for (const element of field.element.querySelectorAll<HTMLElement>('[data-start]')) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const start = Number(element.dataset.start), finish = Number(element.dataset.end);
    if (point.compareBoundaryPoints(Range.START_TO_START, range) <= 0) return start;
    if (point.compareBoundaryPoints(Range.END_TO_END, range) >= 0) continue;
    if (element.dataset.formula) return end ? finish : start;
    const prefix = document.createRange();
    prefix.setStart(element, 0);
    prefix.setEnd(node, offset);
    return start + prefix.toString().length;
  }
  return field.source.length;
}

export function anchorForOffsets(bank: Bank, field: SourceField, start: number, end: number): Anchor {
  // 保护代理对；表情字符不能只保存半个 UTF-16 字符。
  if (start > 0 && /[\uDC00-\uDFFF]/.test(field.source[start] ?? '')) start--;
  if (/[\uDC00-\uDFFF]/.test(field.source[end] ?? '')) end++;
  const question = bank.questions.find(q => q.id === field.ref.questionId);
  if (!question) throw new Error('题目不存在，请重新导入');
  const formula = field.segments.some(s => s.formula && s.start === start && s.end === end);
  const anchor: Anchor = {
    bankId: bank.id, bankVersion: bank.version, questionVersion: question.version,
    ...field.ref, start, end, quote: field.source.slice(start, end),
    prefix: field.source.slice(Math.max(0, start - 24), start), suffix: field.source.slice(end, end + 24),
    kind: formula ? 'formula' : 'text',
  };
  validateAnchor(bank, anchor);
  return anchor;
}

export function anchorForRange(bank: Bank, field: SourceField, range: Range): Anchor {
  if (range.collapsed || !field.element.contains(range.startContainer) || !field.element.contains(range.endContainer))
    throw new Error('请在同一题干、同一选项或同一解析内选择文字');
  return anchorForOffsets(bank, field,
    sourceOffset(field, range.startContainer, range.startOffset, false),
    sourceOffset(field, range.endContainer, range.endOffset, true));
}
