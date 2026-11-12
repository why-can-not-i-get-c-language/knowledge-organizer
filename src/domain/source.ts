export interface SourceSegment { start: number; end: number; formula: boolean; display: boolean }

// 定位与渲染共享数学分隔规则；未闭合内容保留为普通原文。
export function splitSource(source: string): SourceSegment[] {
  const result: SourceSegment[] = [];
  const expression = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?:\\.|[^$\n])+?\$/g;
  let start = 0;
  for (const match of source.matchAll(expression)) {
    const at = match.index;
    if (at > 0 && source[at - 1] === '\\') continue;
    if (at > start) result.push({ start, end: at, formula: false, display: false });
    const end = at + match[0].length;
    result.push({ start: at, end, formula: true, display: match[0].startsWith('$$') || match[0].startsWith('\\[') });
    start = end;
  }
  if (start < source.length) result.push({ start, end: source.length, formula: false, display: false });
  return result;
}
