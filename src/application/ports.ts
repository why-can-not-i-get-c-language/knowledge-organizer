import type { Attempt, Bank, Annotation, Anchor, Conversation, Message } from '../domain/contracts.ts';
import type { ConceptSummary, DiscussionQuote } from './concept-summary.ts';
import type { Workspace } from '../domain/contracts.ts';
import type { QuizScan } from "../domain/contracts.ts";
export interface QuizScanner {
  scan(): Promise<QuizScan>;
  read(path: string): Promise<string>;
  cancel(): Promise<void>;
}
export interface WorkspaceRepository {
  load(): Promise<Workspace | null>;
  save(next: Workspace, expectedRevision: number | null): Promise<Workspace>;
  close(): void;
}
export type { Conversation } from '../domain/contracts.ts';

/** 持久化适配器须以事务原子保存；expectedRevision 实现并发冲突检测。 */
export interface LearningRepository {
  importBank(bank: Bank): Promise<'inserted' | 'already-exists'>;
  loadBank(id: string, version: string): Promise<Bank | null>;
  listBanks(): Promise<Bank[]>;
  createAttempt(attempt: Attempt): Promise<void>;
  loadAttempt(id: string): Promise<Attempt | null>;
  saveAttempt(next: Attempt, expectedRevision: number): Promise<Attempt>;
  listAttempts(): Promise<Attempt[]>;
  // null表示只新建；更新/删除必须提供最后读到的完整快照，防止旧备注覆盖新值。
  saveAnnotation(mark: Annotation, expected: Annotation | null): Promise<void>;
  listAnnotations(attemptId: string): Promise<Annotation[]>;
  deleteAnnotation(id: string, expected: Annotation): Promise<void>;
}
export interface DeviceServices {
  readImportFile(): Promise<string | null>;
  writeExportFile(name: string, content: string): Promise<'saved' | 'download-requested' | 'cancelled'>;
  copyText(content: string): Promise<void>;
}
/** 密钥单独存于系统安全存储，不进入学习记录或备份。 */
export interface SecretStore {
  setDeepSeekKey(value: string): Promise<void>;
  hasDeepSeekKey(): Promise<boolean>;
  removeDeepSeekKey(): Promise<void>;
}
/** 会话按作答/题目/标记隔离；save须在同一事务校验引用和expectedRevision。 */
export interface ConversationRepository {
  createConversation(conversation: Conversation): Promise<void>;
  loadConversation(id: string): Promise<Conversation | null>;
  listConversations(attemptId: string, questionId: string, annotationId?: string): Promise<Conversation[]>;
  saveConversation(next: Conversation, expectedRevision: number): Promise<Conversation>;
  deleteConversation(id: string, expectedRevision: number): Promise<void>;
}
export interface QuestionContext {
  bankId: string; bankVersion: string; questionId: string;
  prompt: string; options: { id: string; text: string }[];
  selectedOptionIds: string[]; understood: boolean | null;
  // 答题阶段不能填入答案解析；点击前应展示实际发送内容。
  correctAnswer?: string[]; explanation?: string; anchor?: Anchor;
  // 讨论原文的选区；发送前须核对sourceId/revision属于当前会话，不能只接受客户端quote文字。
  discussionQuote?: DiscussionQuote;
}
export type AIEvent =
  | { type: 'text'; delta: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheHitTokens?: number }
  | { type: 'finished' };
/** 此接口仅定义协议，尚无真实网络实现。取消/失败必须抛可识别错误，不发 finished。 */
export interface AIProvider {
  stream(request: { model: string; context: QuestionContext; history: Pick<Message, 'role' | 'content'>[];
    question: string; maxOutputTokens: number }, signal: AbortSignal): AsyncIterable<AIEvent>;
}
/** AI只返回概括候选；用户确认后以updateConceptSummary更新，不能覆盖更新中的手写概括。 */
export interface ConceptSummaryProvider {
  summarize(request: { context: QuestionContext; history: Pick<Message, 'role' | 'content'>[];
    currentSummary: ConceptSummary | null; maxOutputTokens: number }, signal: AbortSignal): Promise<string>;
}
export interface BackupPort {
  exportLocalData(): Promise<string>;
  // restore 必须先验证整个备份，明确冲突，再原子写入；格式不兼容不能部分覆盖。
  inspectBackup(json: string): Promise<{ compatible: boolean; conflicts: string[]; error?: string }>;
  restoreBackup(json: string, conflictPolicy: 'reject' | 'keep-existing'): Promise<void>;
}
