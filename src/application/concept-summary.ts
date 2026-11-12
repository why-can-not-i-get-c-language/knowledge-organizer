import { AppError, timestampSchema } from "../domain/contracts.ts";

/** 概括与原始问答分开，手写和AI候选使用同一更新入口；由调用方持久化。 */
export interface ConceptSummary {
  revision: number;
  text: string;
  author: "user" | "ai";
  updatedAt: string;
}
export function updateConceptSummary(
  previous: ConceptSummary | null,
  input: { text: string; author: "user" | "ai" },
  expectedRevision: number | null,
  now: string,
): ConceptSummary {
  if (expectedRevision !== (previous?.revision ?? null))
    throw new AppError(
      "VERSION_CONFLICT",
      "概括已更新，请先查看最新内容再保存",
    );
  if (
    typeof input.text !== "string" ||
    !input.text.trim() ||
    input.text.length > 20000 ||
    !["user", "ai"].includes(input.author) ||
    !timestampSchema.safeParse(now).success ||
    (previous && Date.parse(now) < Date.parse(previous.updatedAt))
  )
    throw new AppError(
      "INVALID_INPUT",
      "概括不能为空、不能超过20000字，更新时间须有效",
    );
  const revision = (previous?.revision ?? -1) + 1;
  if (!Number.isSafeInteger(revision))
    throw new AppError("VERSION_CONFLICT", "概括版本已达上限");
  return {
    revision,
    text: input.text.trim(),
    author: input.author,
    updatedAt: now,
  };
}

export interface DiscussionQuote {
  sourceId: string;
  revision: number;
  start: number;
  end: number;
  quote: string;
}
/** 对回答、用户消息或概括使用原文偏移；重复文字不能靠字符串搜索猜位置。 */
export function quoteDiscussionText(
  sourceId: string,
  revision: number,
  source: string,
  start: number,
  end: number,
): DiscussionQuote {
  if (
    !sourceId ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > source.length
  )
    throw new AppError("INVALID_INPUT", "选文位置无效，请重新选择");
  if (/[\uDC00-\uDFFF]/.test(source[start] ?? "")) start--;
  if (/[\uDC00-\uDFFF]/.test(source[end] ?? "")) end++;
  return { sourceId, revision, start, end, quote: source.slice(start, end) };
}
