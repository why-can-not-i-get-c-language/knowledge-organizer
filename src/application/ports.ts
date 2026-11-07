import type { Attempt, Bank, Annotation, Anchor } from '../domain/contracts.ts';

/** 持久化适配器须以事务原子保存；expectedRevision 实现并发冲突检测。 */
export interface LearningRepository {
  importBank(bank: Bank): Promise<'inserted' | 'already-exists'>;
  createAttempt(attempt: Attempt): Promise<void>;
  loadAttempt(id: string): Promise<Attempt | null>;
  saveAttempt(next: Attempt, expectedRevision: number): Promise<Attempt>;
  listAttempts(): Promise<Attempt[]>;
  saveAnnotation(mark: Annotation): Promise<void>;
  listAnnotations(attemptId: string): Promise<Annotation[]>;
  deleteAnnotation(id: string): Promise<void>;
}
export interface DeviceServices {
  readImportFile(): Promise<string | null>;
  writeExportFile(name: string, content: string): Promise<'saved' | 'cancelled'>;
  copyText(content: string): Promise<void>;
}
/** 密钥单独存于系统安全存储，不进入学习记录或备份。 */
export interface SecretStore {
  setDeepSeekKey(value: string): Promise<void>;
  hasDeepSeekKey(): Promise<boolean>;
  removeDeepSeekKey(): Promise<void>;
}
export interface Conversation {
  id: string; attemptId: string; questionId: string; annotationId?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}
export interface QuestionContext {
  bankId: string; bankVersion: string; questionId: string;
  prompt: string; options: { id: string; text: string }[];
  selectedOptionIds: string[]; understood: boolean | null;
  // 答题阶段不能填入答案解析；点击前应展示实际发送内容。
  correctAnswer?: string[]; explanation?: string; anchor?: Anchor;
}
export type AIEvent =
  | { type: 'text'; delta: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheHitTokens?: number }
  | { type: 'finished' };
/** 此接口仅定义协议，尚无真实网络实现。取消/失败必须抛可识别错误，不发 finished。 */
export interface AIProvider {
  stream(request: { model: string; context: QuestionContext; history: Conversation['messages'];
    question: string; maxOutputTokens: number }, signal: AbortSignal): AsyncIterable<AIEvent>;
}
export interface BackupPort {
  exportLocalData(): Promise<string>;
  // restore 必须先验证整个备份，明确冲突，再原子写入；格式不兼容不能部分覆盖。
  inspectBackup(json: string): Promise<{ compatible: boolean; conflicts: string[] }>;
  restoreBackup(json: string, conflictPolicy: 'reject' | 'keep-existing'): Promise<void>;
}
