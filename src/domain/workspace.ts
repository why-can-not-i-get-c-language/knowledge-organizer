import { z } from "zod";
import {
  anchorSchema,
  annotationSchema,
  bankSchema,
  conversationSchema,
  timestampSchema,
  AppError,
} from "./contracts.ts";
import type { Backup } from "./contracts.ts";
import { anchorMatches } from "./anchors.ts";

const id = z.string().min(1).max(100);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const summary = z
  .object({
    revision,
    text: z.string().trim().min(1).max(20000),
    author: z.enum(["user", "ai"]),
    updatedAt: timestampSchema,
  })
  .strict();
const quote = z
  .object({
    sourceId: z.string().min(1).max(200),
    revision,
    start: revision,
    end: revision,
    quote: z.string().min(1).max(200000),
  })
  .strict()
  .refine(
    (q) => q.end > q.start && q.quote.length === q.end - q.start,
    "讨论选文范围无效",
  );
const discussion = z
  .object({
    id,
    anchor: anchorSchema,
    summary: summary.nullable(),
    summaryDraft: z.string().max(20000),
    drafts: z
      .array(
        z
          .object({
            id,
            text: z.string().min(1).max(20000),
            quote: quote.optional(),
          })
          .strict(),
      )
      .max(1000),
    draft: z.string().max(20000),
  })
  .strict();
const answer = z
  .object({
    selected: z.array(id).max(20),
    locked: z.boolean(),
    understood: z.boolean().nullable(),
    marks: z.array(anchorSchema).max(1000),
    resolvedMarks: z.array(z.string()).max(1000),
    discussions: z.record(z.string(), discussion),
  })
  .strict();
const round = z
  .object({
    id,
    createdAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    mode: z.enum(["immediate", "batch"]),
    index: revision,
    submitted: z.boolean(),
    answers: z.array(answer).min(1).max(1000),
  })
  .strict();
const group = z
  .object({
    id,
    name: z.string().trim().min(1).max(80),
    parent: id.nullable(),
    open: z.boolean(),
  })
  .strict();
const card = z
  .object({
    id,
    bank: bankSchema,
    group: id.nullable(),
    round: round.optional(),
    history: z.array(round).max(10000),
  })
  .strict();
export const markKey = (a: {
  field: string;
  optionId?: string;
  start: number;
  end: number;
}) => JSON.stringify([a.field, a.optionId ?? null, a.start, a.end]);
export const workspaceSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    groups: z.array(group).max(2000),
    cards: z.array(card).max(1000),
    legacyAnnotations: z.array(annotationSchema).max(100000),
    legacyConversations: z.array(conversationSchema).max(10000),
    location: z
      .object({
        screen: z.enum(["library", "setup", "quiz", "results"]),
        cardId: id.nullable(),
        group: id.nullable(),
      })
      .strict(),
    preferences: z
      .object({ fontSize: z.number().int().min(14).max(30) })
      .strict(),
  })
  .strict()
  .superRefine((w, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const groups = new Map(w.groups.map((g) => [g.id, g]));
    if (
      groups.size !== w.groups.length ||
      new Set(w.cards.map((c) => c.id)).size !== w.cards.length ||
      new Set(w.cards.map((c) => JSON.stringify([c.bank.id, c.bank.version])))
        .size !== w.cards.length
    )
      fail("分组或题集重复");
    for (const g of w.groups) {
      const seen = new Set<string>();
      let at: string | null = g.id;
      while (at !== null) {
        if (seen.has(at) || !groups.has(at)) {
          fail("分组循环或父组缺失");
          break;
        }
        seen.add(at);
        at = groups.get(at)!.parent;
      }
    }
    const roundIds = new Set<string>();
    for (const c of w.cards) {
      if (c.group !== null && !groups.has(c.group)) fail("套题所属分组缺失");
      for (const r of [...c.history, ...(c.round ? [c.round] : [])]) {
        if (roundIds.has(r.id)) fail("练习轮次重复");
        roundIds.add(r.id);
        if (
          r.index >= c.bank.questions.length ||
          r.answers.length !== c.bank.questions.length
        ) {
          fail("题目页或答案数量不一致");
          continue;
        }
        if (
          r.completedAt &&
          (Date.parse(r.completedAt) < Date.parse(r.createdAt) ||
            r.answers.some((a) => !a.locked || a.understood === null))
        )
          fail("已完成轮次必须已提交并完成自评");
        for (let i = 0; i < r.answers.length; i++) {
          const a = r.answers[i]!,
            q = c.bank.questions[i]!;
          if (
            new Set(a.selected).size !== a.selected.length ||
            a.selected.some((id) => !q.options.some((o) => o.id === id)) ||
            (q.type !== "multiple" && a.selected.length > 1) ||
            (a.locked && !a.selected.length) ||
            (!a.locked && a.understood !== null)
          )
            fail("答案或自评状态不合法");
          if (r.mode === "batch" && a.locked !== r.submitted)
            fail("整套提交状态不一致");
          if (
            a.marks.some(
              (m) =>
                m.questionId !== q.id ||
                !anchorMatches(c.bank, m) ||
                (m.field === "explanation" && !a.locked),
            )
          )
            fail("标记原文失配或解析未解锁");
          if (new Set(a.marks.map(markKey)).size !== a.marks.length)
            fail("标记重复");
          if (
            a.resolvedMarks.some(
              (key) => !a.marks.some((m) => markKey(m) === key),
            )
          )
            fail("已解除标记不存在");
          for (const [key, d] of Object.entries(a.discussions)) {
            if (
              key !== markKey(d.anchor) ||
              !a.marks.some(
                (m) => JSON.stringify(m) === JSON.stringify(d.anchor),
              ) ||
              new Set(d.drafts.map((m) => m.id)).size !== d.drafts.length
            )
              fail("讨论与标记不对应");
          }
        }
      }
    }
    const current = w.cards.find((c) => c.id === w.location.cardId);
    if (w.location.screen === "results" && !current?.round?.completedAt)
      fail("结果页必须对应已完成轮次");
    const rounds = new Map(
      w.cards.flatMap((c) =>
        [...c.history, ...(c.round ? [c.round] : [])].map(
          (r) => [r.id, { card: c, round: r }] as const,
        ),
      ),
    );
    if (
      new Set(w.legacyAnnotations.map((a) => a.id)).size !==
        w.legacyAnnotations.length ||
      new Set(w.legacyConversations.map((c) => c.id)).size !==
        w.legacyConversations.length
    )
      fail("旧记录ID重复");
    for (const mark of w.legacyAnnotations) {
      const owner = rounds.get(mark.attemptId);
      if (!owner || !anchorMatches(owner.card.bank, mark.anchor))
        fail("旧标记与题目快照不对应");
    }
    for (const conversation of w.legacyConversations) {
      const owner = rounds.get(conversation.attemptId);
      const mark = conversation.annotationId
        ? w.legacyAnnotations.find((a) => a.id === conversation.annotationId)
        : undefined;
      if (
        !owner ||
        !owner.card.bank.questions.some(
          (q) => q.id === conversation.questionId,
        ) ||
        (conversation.annotationId &&
          (!mark ||
            mark.attemptId !== conversation.attemptId ||
            mark.anchor.questionId !== conversation.questionId))
      )
        fail("旧会话归属不一致");
    }
    if (
      (w.location.group !== null && !groups.has(w.location.group)) ||
      (w.location.cardId !== null && !current) ||
      (w.location.screen !== "library" && !current) ||
      (["quiz", "results"].includes(w.location.screen) && !current?.round)
    )
      fail("恢复位置不存在");
    if (Date.parse(w.updatedAt) < Date.parse(w.createdAt))
      fail("保存时间早于创建时间");
  });
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceCard = Workspace["cards"][number];
export type WorkspaceRound = NonNullable<WorkspaceCard["round"]>;
export type WorkspaceAnswer = WorkspaceRound["answers"][number];
export type WorkspaceGroup = Workspace["groups"][number];
export type WorkspaceDiscussion = WorkspaceAnswer["discussions"][string];

export function parseWorkspace(value: unknown): Workspace {
  const result = workspaceSchema.safeParse(value);
  if (!result.success)
    throw new AppError(
      "INVALID_INPUT",
      `学习空间格式或引用不合法：${result.error.issues[0]?.message ?? ""}。原记录已保留`,
    );
  return result.data;
}
export function newWorkspace(now: string): Workspace {
  return parseWorkspace({
    schemaVersion: 1,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    groups: [
      { id: "root", name: "我的学习", parent: null, open: true },
      { id: "term", name: "本学期", parent: "root", open: true },
    ],
    cards: [],
    preferences: { fontSize: 18 },
    legacyAnnotations: [],
    legacyConversations: [],
    location: { screen: "library", cardId: null, group: null },
  });
}
/** 从旧库只复制读取；保留旧ID、答案、标记、备注和完整问答，不改写旧库。 */
export function migrateLegacyWorkspace(backup: Backup, now: string): Workspace {
  const result = newWorkspace(now);
  for (const bank of backup.banks) {
    const c: WorkspaceCard = {
      id: crypto.randomUUID(),
      bank,
      group: "term",
      history: [],
    };
    for (const attempt of backup.attempts.filter(
      (a) => a.bank.id === bank.id && a.bank.version === bank.version,
    )) {
      const r: WorkspaceRound = {
        id: attempt.id,
        createdAt: attempt.createdAt,
        ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
        mode: "batch",
        index: 0,
        submitted: attempt.phase !== "answering",
        answers: attempt.responses.map((response) => {
          const marks = backup.annotations.filter(
            (m) =>
              m.attemptId === attempt.id &&
              m.anchor.questionId === response.questionId,
          );
          const unique = [
            ...new Map(marks.map((m) => [markKey(m.anchor), m])).values(),
          ];
          const a: WorkspaceAnswer = {
            selected: response.selectedOptionIds,
            locked: attempt.phase !== "answering",
            understood: response.understood,
            marks: unique.map((m) => m.anchor),
            resolvedMarks: unique
              .filter((m) => m.resolved)
              .map((m) => markKey(m.anchor)),
            discussions: {},
          };
          for (const mark of marks)
            a.discussions[markKey(mark.anchor)] = {
              id: mark.id,
              anchor: mark.anchor,
              summary: mark.note.trim()
                ? {
                    revision: 0,
                    text: mark.note,
                    author: "user",
                    updatedAt: mark.updatedAt,
                  }
                : null,
              summaryDraft: mark.note,
              drafts: [],
              draft: "",
            };
          return a;
        }),
      };
      c.history.push(r);
    }
    c.history.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    c.round = c.history.pop();
    result.cards.push(c);
  }
  result.legacyConversations = backup.conversations;
  result.legacyAnnotations = backup.annotations;
  return parseWorkspace(result);
}
/** 已锁定答案与历史身份不可被旧窗口或整包恢复覆盖；疑问可独立继续编辑。 */
export function validateWorkspaceUpdate(
  previous: Workspace,
  next: Workspace,
): void {
  for (const key of ["legacyAnnotations", "legacyConversations"] as const) {
    const after = new Map(
      next[key].map((item) => [item.id, JSON.stringify(item)]),
    );
    if (
      previous[key].some((item) => after.get(item.id) !== JSON.stringify(item))
    )
      throw new AppError("VERSION_CONFLICT", "旧版原始记录不能被删除或改写");
  }
  if (
    previous.createdAt !== next.createdAt ||
    Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)
  )
    throw new AppError("VERSION_CONFLICT", "不能用旧学习空间覆盖当前记录");
  const cards = new Map(next.cards.map((c) => [c.id, c]));
  for (const old of previous.cards) {
    const current = cards.get(old.id);
    if (!current || JSON.stringify(old.bank) !== JSON.stringify(current.bank))
      throw new AppError("VERSION_CONFLICT", "不能删除或改写已有题集快照");
    const rounds = new Map(
      [...current.history, ...(current.round ? [current.round] : [])].map(
        (r) => [r.id, r],
      ),
    );
    for (const before of [...old.history, ...(old.round ? [old.round] : [])]) {
      const after = rounds.get(before.id);
      if (
        !after ||
        before.mode !== after.mode ||
        before.createdAt !== after.createdAt ||
        (before.completedAt && before.completedAt !== after.completedAt)
      )
        throw new AppError("VERSION_CONFLICT", "历史轮次不能被替换或删除");
      before.answers.forEach((a, i) => {
        const b = after.answers[i]!;
        if (
          (a.locked &&
            (!b.locked ||
              JSON.stringify(a.selected) !== JSON.stringify(b.selected))) ||
          (before.completedAt && a.understood !== b.understood)
        )
          throw new AppError(
            "INVALID_STATE",
            "已提交答案及完成后的自评只读，请新建一轮",
          );
      });
    }
  }
}

export function mergeWorkspaceBackup(
  current: Workspace,
  imported: Workspace,
): Workspace {
  const next = structuredClone(current);
  for (const group of imported.groups)
    if (!next.groups.some((g) => g.id === group.id)) next.groups.push(group);
  for (const card of imported.cards) {
    const existing = next.cards.find(
      (c) =>
        c.id === card.id ||
        (c.bank.id === card.bank.id && c.bank.version === card.bank.version),
    );
    if (!existing) {
      next.cards.push(card);
      continue;
    }
    if (JSON.stringify(existing.bank) !== JSON.stringify(card.bank))
      throw new AppError(
        "VERSION_CONFLICT",
        "同一题集版本内容冲突，整包未恢复",
      );
    const ids = new Set(
      [...existing.history, ...(existing.round ? [existing.round] : [])].map(
        (r) => r.id,
      ),
    );
    for (const round of [...card.history, ...(card.round ? [card.round] : [])])
      if (!ids.has(round.id)) {
        existing.history.push(round);
        ids.add(round.id);
      }
    if (!existing.round && existing.history.length) {
      existing.history.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      existing.round = existing.history.pop();
    }
  }
  for (const c of imported.legacyConversations)
    if (!next.legacyConversations.some((old) => old.id === c.id))
      next.legacyConversations.push(c);
  for (const a of imported.legacyAnnotations)
    if (!next.legacyAnnotations.some((old) => old.id === a.id))
      next.legacyAnnotations.push(a);
  return parseWorkspace(next);
}
