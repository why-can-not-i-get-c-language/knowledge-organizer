import type { z } from 'zod';
import { AppError, bankSchema, annotationSchema, conversationSchema } from '../domain/contracts.ts';
import type { Annotation, Attempt, Bank, Conversation, Backup } from '../domain/contracts.ts';
import type { BackupPort, ConversationRepository, LearningRepository } from '../application/ports.ts';
import { parseAttempt, parseAnnotation, parseConversation, parseBackup, serializeBackup, validateAttemptUpdate, validateConversationUpdate } from '../domain/records.ts';

const stores = ['banks', 'attempts', 'annotations', 'conversations'];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function storageError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'VersionError') return new AppError('VERSION_CONFLICT', '本地数据库版本较新，请使用兼容版本打开，不会降级或清空数据');
  if (name === 'QuotaExceededError') return new AppError('SAVE_FAILED', '设备存储空间不足，本次修改未保存，请释放空间后重试');
  if (name === 'SecurityError') return new AppError('SAVE_FAILED', '本地存储被禁止，请检查浏览器或应用的存储权限后重试');
  return new AppError('SAVE_FAILED', '本地存储操作失败，请重新打开应用后重试，原有数据不会自动清空');
}
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '记录格式不合法，请检查来源数据后重试');
  return parsed.data;
}
function stored<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('SAVE_FAILED', '本地记录校验失败，已保留原件，请使用兼容版本检查数据');
  return parsed.data;
}
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}
function conflict(message: string): never { throw new AppError('VERSION_CONFLICT', message); }
function requireAttempt(attempt: Attempt | null): Attempt {
  if (!attempt) throw new AppError('INVALID_INPUT', '所属作答不存在，请重新打开学习记录');
  return attempt;
}

/** 网页/系统WebView的真实存储适配。没有内存或localStorage成功回退。 */
export class IndexedDbRepository implements LearningRepository, ConversationRepository, BackupPort {
  private closed = false;
  private constructor(private readonly database: IDBDatabase) {
    database.onversionchange = () => this.close();
    database.onclose = () => { this.closed = true; };
  }

  static open(name = 'knowledge-organizer.learning'): Promise<IndexedDbRepository> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new AppError('SAVE_FAILED', '当前环境没有本地数据库，请使用受支持的浏览器或应用')); return; }
      let opening: IDBOpenDBRequest;
      try { opening = indexedDB.open(name, 1); }
      catch (error) { reject(storageError(error)); return; }
      let finished = false;
      const fail = (error: unknown) => { if (!finished) { finished = true; reject(storageError(error)); } };
      opening.onupgradeneeded = event => {
        // 首个数据库格式仅从空库创建；后续变更必须显式编写迁移。
        if (event.oldVersion !== 0) { opening.transaction?.abort(); return; }
        const db = opening.result;
        db.createObjectStore('banks', { keyPath: ['id', 'version'] });
        db.createObjectStore('attempts', { keyPath: 'id' });
        const annotations = db.createObjectStore('annotations', { keyPath: 'id' });
        annotations.createIndex('attemptId', 'attemptId');
        const conversations = db.createObjectStore('conversations', { keyPath: 'id' });
        conversations.createIndex('question', ['attemptId', 'questionId']);
        conversations.createIndex('annotationId', 'annotationId');
      };
      opening.onblocked = () => fail(new AppError('SAVE_FAILED', '其他窗口阻止数据库打开，请关闭其他学习窗口后重试'));
      opening.onerror = () => fail(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        if (finished) { db.close(); return; }
        try {
          if (!same([...db.objectStoreNames].sort(), [...stores].sort())) throw new Error('未知表结构');
          const tx = db.transaction(stores, 'readonly');
          for (const name of stores) {
            const store = tx.objectStore(name);
            const keys = name === 'banks' ? ['id', 'version'] : 'id';
            const indexes = name === 'annotations' ? ['attemptId'] : name === 'conversations' ? ['annotationId', 'question'] : [];
            if (!same(store.keyPath, keys) || store.autoIncrement || !same([...store.indexNames].sort(), indexes)) throw new Error('未知表结构');
          }
          const annotations = tx.objectStore('annotations').index('attemptId');
          const conversations = tx.objectStore('conversations');
          if (annotations.keyPath !== 'attemptId' || annotations.unique || annotations.multiEntry ||
            !same(conversations.index('question').keyPath, ['attemptId', 'questionId']) ||
            conversations.index('question').unique || conversations.index('question').multiEntry ||
            conversations.index('annotationId').keyPath !== 'annotationId' ||
            conversations.index('annotationId').unique || conversations.index('annotationId').multiEntry) throw new Error('未知索引');
        } catch {
          db.close(); fail(new AppError('SAVE_FAILED', '数据库结构不兼容，已保留原库，请使用兼容版本打开')); return;
        }
        finished = true;
        resolve(new IndexedDbRepository(db));
      };
    });
  }

  close(): void { this.closed = true; this.database.close(); }

  private transact<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new AppError('SAVE_FAILED', '数据库连接已关闭，请重新打开应用后重试')); return; }
      let tx: IDBTransaction;
      try { tx = this.database.transaction(stores, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); }
      catch (error) { reject(storageError(error)); return; }
      let result: T, ready = false, failure: unknown;
      // 请求成功不等于提交成功，必须等完整事务完成后才向调用方报告成功。
      tx.oncomplete = () => ready ? resolve(result) : reject(new AppError('SAVE_FAILED', '本地事务未完整执行，请重试'));
      tx.onabort = () => reject(storageError(failure ?? tx.error));
      // work只等待本事务的IDB请求，不在事务中等待网络、计时器或用户操作。
      void work(tx).then(value => { result = value; ready = true; }).catch(error => {
        failure = error;
        try { tx.abort(); } catch { reject(storageError(error)); }
      });
    });
  }

  private async matchingBank(tx: IDBTransaction, bank: Bank): Promise<void> {
    const value: unknown = await request(tx.objectStore('banks').get([bank.id, bank.version]));
    if (value === undefined) throw new AppError('INVALID_INPUT', '题集尚未导入，请先导入题集再创建或保存作答');
    if (!same(stored(bankSchema, value), bank)) conflict('同ID和版本的题集内容不同，请使用新的题集版本');
  }
  private async attempt(tx: IDBTransaction, id: string): Promise<Attempt | null> {
    const value: unknown = await request(tx.objectStore('attempts').get(id));
    if (value === undefined) return null;
    const attempt = parseAttempt(value);
    await this.matchingBank(tx, attempt.bank);
    return attempt;
  }
  private async annotation(tx: IDBTransaction, value: unknown): Promise<Annotation> {
    const mark = stored(annotationSchema, value);
    return parseAnnotation(mark, requireAttempt(await this.attempt(tx, mark.attemptId)));
  }
  private async conversation(tx: IDBTransaction, value: Conversation): Promise<Conversation> {
    const attempt = requireAttempt(await this.attempt(tx, value.attemptId));
    let mark: Annotation | undefined;
    if (value.annotationId !== undefined) {
      const raw: unknown = await request(tx.objectStore('annotations').get(value.annotationId));
      if (raw !== undefined) mark = await this.annotation(tx, raw);
    }
    return parseConversation(value, attempt, mark);
  }

  async importBank(value: Bank): Promise<'inserted' | 'already-exists'> {
    const bank = input(bankSchema, value);
    return this.transact('readwrite', async tx => {
      const store = tx.objectStore('banks');
      const current: unknown = await request(store.get([bank.id, bank.version]));
      if (current !== undefined) {
        if (!same(stored(bankSchema, current), bank)) conflict('同ID和版本的题集内容不同，请修改版本后重新导入');
        return 'already-exists';
      }
      await request(store.add(bank)); return 'inserted';
    });
  }
  async loadBank(id: string, version: string): Promise<Bank | null> {
    return this.transact('readonly', async tx => {
      const value: unknown = await request(tx.objectStore('banks').get([id, version]));
      return value === undefined ? null : stored(bankSchema, value);
    });
  }
  async listBanks(): Promise<Bank[]> {
    return this.transact('readonly', async tx => {
      const values: unknown[] = await request(tx.objectStore('banks').getAll());
      return values.map(value => stored(bankSchema, value));
    });
  }
  async createAttempt(value: Attempt): Promise<void> {
    const attempt = parseAttempt(value);
    if (attempt.revision !== 0 || attempt.phase !== 'answering') throw new AppError('INVALID_STATE', '普通新建作答必须从答题阶段和版本0开始');
    return this.transact('readwrite', async tx => {
      const store = tx.objectStore('attempts');
      if (await request(store.getKey(attempt.id)) !== undefined) conflict('作答ID已存在，请创建新的作答ID');
      await this.matchingBank(tx, attempt.bank);
      await request(store.add(attempt));
    });
  }
  async loadAttempt(id: string): Promise<Attempt | null> {
    return this.transact('readonly', tx => this.attempt(tx, id));
  }
  async listAttempts(): Promise<Attempt[]> {
    return this.transact('readonly', async tx => {
      const ids = await request(tx.objectStore('attempts').getAllKeys());
      const result: Attempt[] = [];
      for (const id of ids) result.push(requireAttempt(await this.attempt(tx, String(id))));
      return result;
    });
  }
  async saveAttempt(value: Attempt, expectedRevision: number): Promise<Attempt> {
    const next = parseAttempt(value);
    return this.transact('readwrite', async tx => {
      const previous = requireAttempt(await this.attempt(tx, next.id));
      validateAttemptUpdate(previous, next, expectedRevision);
      const saved = { ...next, revision: previous.revision + 1 };
      await request(tx.objectStore('attempts').put(saved)); return saved;
    });
  }
  async saveAnnotation(value: Annotation, expected: Annotation | null): Promise<void> {
    const next = input(annotationSchema, value), before = expected === null ? null : input(annotationSchema, expected);
    return this.transact('readwrite', async tx => {
      const store = tx.objectStore('annotations');
      const raw: unknown = await request(store.get(next.id));
      const current = raw === undefined ? null : await this.annotation(tx, raw);
      if (!same(current, before)) conflict('标记已被修改或删除，请重新读取后再保存');
      const attempt = requireAttempt(await this.attempt(tx, next.attemptId));
      parseAnnotation(next, attempt);
      if (current && (current.attemptId !== next.attemptId || current.createdAt !== next.createdAt ||
        !same(current.anchor, next.anchor) || Date.parse(next.updatedAt) < Date.parse(current.updatedAt)))
        throw new AppError('INVALID_STATE', '不能移动既有标记或用旧备注覆盖新修改，请新建标记或重新读取');
      await request(current ? store.put(next) : store.add(next));
    });
  }
  async listAnnotations(attemptId: string): Promise<Annotation[]> {
    return this.transact('readonly', async tx => {
      const values: unknown[] = await request(tx.objectStore('annotations').index('attemptId').getAll(attemptId));
      const result: Annotation[] = [];
      for (const value of values) result.push(await this.annotation(tx, value));
      return result;
    });
  }
  async deleteAnnotation(id: string, expected: Annotation): Promise<void> {
    const before = input(annotationSchema, expected);
    return this.transact('readwrite', async tx => {
      const store = tx.objectStore('annotations');
      const raw: unknown = await request(store.get(id));
      if (before.id !== id || raw === undefined || !same(await this.annotation(tx, raw), before)) conflict('标记已变化，请重新读取后再删除');
      if (await request(tx.objectStore('conversations').index('annotationId').count(id)))
        throw new AppError('INVALID_STATE', '此标记仍有关联问答，请先处理问答记录再删除标记');
      await request(store.delete(id));
    });
  }
  async createConversation(value: Conversation): Promise<void> {
    const conversation = input(conversationSchema, value);
    if (conversation.revision !== 0) throw new AppError('INVALID_STATE', '新会话必须从版本0开始');
    return this.transact('readwrite', async tx => {
      const store = tx.objectStore('conversations');
      if (await request(store.getKey(conversation.id)) !== undefined) conflict('会话ID已存在，请新建会话');
      await this.conversation(tx, conversation);
      await request(store.add(conversation));
    });
  }
  async loadConversation(id: string): Promise<Conversation | null> {
    return this.transact('readonly', async tx => {
      const raw: unknown = await request(tx.objectStore('conversations').get(id));
      return raw === undefined ? null : this.conversation(tx, stored(conversationSchema, raw));
    });
  }
  async listConversations(attemptId: string, questionId: string, annotationId?: string): Promise<Conversation[]> {
    return this.transact('readonly', async tx => {
      const values: unknown[] = await request(tx.objectStore('conversations').index('question').getAll([attemptId, questionId]));
      const result: Conversation[] = [];
      for (const value of values) {
        const conversation = stored(conversationSchema, value);
        if (conversation.annotationId === annotationId) result.push(await this.conversation(tx, conversation));
      }
      return result;
    });
  }
  async saveConversation(value: Conversation, expectedRevision: number): Promise<Conversation> {
    const next = input(conversationSchema, value);
    return this.transact('readwrite', async tx => {
      const store = tx.objectStore('conversations');
      const raw: unknown = await request(store.get(next.id));
      if (raw === undefined) throw new AppError('INVALID_INPUT', '会话不存在，请重新打开疑问');
      const previous = await this.conversation(tx, stored(conversationSchema, raw));
      await this.conversation(tx, next);
      validateConversationUpdate(previous, next, expectedRevision);
      const saved = { ...next, revision: previous.revision + 1 };
      await request(store.put(saved)); return saved;
    });
  }
  async deleteConversation(id: string, expectedRevision: number): Promise<void> {
    return this.transact('readwrite', async tx => {
      const store = tx.objectStore('conversations');
      const raw: unknown = await request(store.get(id));
      if (raw === undefined) conflict('会话已被删除，请重新读取记录');
      const current = await this.conversation(tx, stored(conversationSchema, raw));
      if (current.revision !== expectedRevision) conflict('会话已有新消息，请重新读取后再删除');
      await request(store.delete(id));
    });
  }

  private async snapshot(tx: IDBTransaction): Promise<Backup> {
    const [banks, attempts, annotations, conversations] = await Promise.all(stores.map(name => request(tx.objectStore(name).getAll())));
    return parseBackup(JSON.stringify({ format: 'knowledge-organizer.backup', schemaVersion: 1,
      exportedAt: new Date().toISOString(), banks, attempts, annotations, conversations }));
  }
  async exportLocalData(): Promise<string> {
    return this.transact('readonly', async tx => serializeBackup(await this.snapshot(tx)));
  }
  private conflicts(current: Backup, incoming: Backup): string[] {
    const result: string[] = [];
    for (const name of ['banks', 'attempts', 'annotations', 'conversations'] as const) {
      const key = (record: { id: string; version?: string }) => name === 'banks' ? JSON.stringify([record.id, record.version]) : record.id;
      const existing = new Map(current[name].map(record => [key(record), record]));
      for (const record of incoming[name]) {
        const old = existing.get(key(record));
        if (old && !same(old, record)) result.push(`${name}: ${key(record)}`);
      }
    }
    return result;
  }
  async inspectBackup(json: string): Promise<{ compatible: boolean; conflicts: string[]; error?: string }> {
    let incoming: Backup;
    try { incoming = parseBackup(json); }
    catch (error) { return { compatible: false, conflicts: [], error: (error as Error).message }; }
    return this.transact('readonly', async tx => ({ compatible: true, conflicts: this.conflicts(await this.snapshot(tx), incoming) }));
  }
  async restoreBackup(json: string, conflictPolicy: 'reject' | 'keep-existing'): Promise<void> {
    const incoming = parseBackup(json);
    if (!['reject', 'keep-existing'].includes(conflictPolicy)) throw new AppError('INVALID_INPUT', '请选择明确的恢复冲突策略');
    return this.transact('readwrite', async tx => {
      const current = await this.snapshot(tx);
      if (conflictPolicy === 'reject' && this.conflicts(current, incoming).length) conflict('备份与现有记录有冲突，请预览后选择保留现有记录');
      const merged = structuredClone(current);
      // 此时间仅供合并集合校验，不写成实际导出时间，不更改记录的原始时间。
      merged.exportedAt = new Date(Math.max(Date.parse(current.exportedAt), Date.parse(incoming.exportedAt))).toISOString();
      const additions: { store: string; value: unknown }[] = [];
      for (const name of ['banks', 'attempts', 'annotations', 'conversations'] as const) {
        const key = (record: { id: string; version?: string }) => name === 'banks' ? JSON.stringify([record.id, record.version]) : record.id;
        const keys = new Set(current[name].map(key));
        for (const record of incoming[name]) if (!keys.has(key(record))) {
          // 各集合类型由随后的全包校验再次核对，写入前不得跳过引用校验。
          (merged[name] as unknown[]).push(record); additions.push({ store: name, value: record });
        }
      }
      parseBackup(JSON.stringify(merged));
      for (const addition of additions) await request(tx.objectStore(addition.store).add(addition.value));
    });
  }
}
