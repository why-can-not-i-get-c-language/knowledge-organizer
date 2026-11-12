export interface SaveStatus { state: 'saved' | 'saving' | 'error'; pending: number; error: Error | null }
interface Operation<T> { reduce: (value: T) => T; key?: string }

/** 每个记录一个队列；同键尾操作可合并，阶段变更不指定键，保留提交边界。 */
export class SaveCoordinator<T> {
  private confirmed: T;
  private draft: T;
  private queue: Operation<T>[] = [];
  private running: Promise<void> | null = null;
  private active = false;
  private failure: Error | null = null;
  private readonly save: (next: T, previous: T) => Promise<T>;
  private readonly changed: (status: SaveStatus) => void;
  constructor(initial: T, save: (next: T, previous: T) => Promise<T>,
    changed: (status: SaveStatus) => void = () => {}) {
    this.save = save; this.changed = changed;
    this.confirmed = structuredClone(initial); this.draft = structuredClone(initial);
  }
  get value(): T { return structuredClone(this.draft); }
  get status(): SaveStatus { return { state: this.failure ? 'error' : this.queue.length ? 'saving' : 'saved', pending: this.queue.length, error: this.failure }; }
  edit(reduce: (value: T) => T, key?: string): void {
    const candidate = reduce(structuredClone(this.draft));
    const tail = this.queue.length - 1;
    if (key && tail >= (this.active ? 1 : 0) && this.queue[tail]?.key === key) this.queue[tail] = { reduce, key };
    else this.queue.push({ reduce, key });
    this.draft = structuredClone(candidate);
    this.changed(this.status);
    if (!this.failure) this.start();
  }
  private start(): void {
    if (this.running || !this.queue.length) return;
    this.running = Promise.resolve().then(async () => {
      while (this.queue.length && !this.failure) {
        this.active = true;
        try {
          const target = this.queue[0]!.reduce(structuredClone(this.confirmed));
          const saved = await this.save(target, structuredClone(this.confirmed));
          this.confirmed = structuredClone(saved);
          this.queue.shift();
          this.draft = this.queue.reduce((state, operation) => operation.reduce(state), structuredClone(this.confirmed));
        } catch (error) { this.failure = error instanceof Error ? error : new Error('保存失败，请重试'); }
        finally { this.active = false; this.changed(this.status); }
      }
    }).finally(() => { this.running = null; });
  }
  async flush(): Promise<void> {
    this.start();
    if (this.running) await this.running;
    if (this.failure) throw this.failure;
  }
  async retry(): Promise<void> { this.failure = null; await this.flush(); }
  discardPending(): void {
    if (this.running) throw new Error('正在保存，请等待当前请求结束后再撤销');
    this.queue = []; this.failure = null; this.draft = structuredClone(this.confirmed); this.changed(this.status);
  }
}
