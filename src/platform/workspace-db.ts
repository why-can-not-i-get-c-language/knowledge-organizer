import { AppError } from "../domain/contracts.ts";
import type { Workspace } from "../domain/contracts.ts";
import type { WorkspaceRepository } from "../application/ports.ts";
import {
  parseWorkspace,
  validateWorkspaceUpdate,
} from "../domain/workspace.ts";

/** 新界面使用独立工作空间，不升级或清空旧学习库；CAS与整包快照在同一事务提交。 */
export class WorkspaceDb implements WorkspaceRepository {
  private database: IDBDatabase;
  private closed = false;
  private constructor(database: IDBDatabase) {
    this.database = database;
    database.onversionchange = () => this.close();
    database.onclose = () => {
      this.closed = true;
    };
  }
  static open(name = "knowledge-organizer.workspace"): Promise<WorkspaceDb> {
    return new Promise((resolve, reject) => {
      let abandoned = false;
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = (event) => {
        if (event.oldVersion !== 0) {
          request.transaction?.abort();
          return;
        }
        request.result.createObjectStore("workspace");
      };
      request.onblocked = () => {
        abandoned = true;
        reject(
          new AppError(
            "SAVE_FAILED",
            "其他窗口阻止打开，请关闭其他学习窗口重试",
          ),
        );
      };
      request.onerror = () =>
        reject(
          new AppError(
            "SAVE_FAILED",
            "无法打开学习空间，原记录未清理，请使用兼容版本重试",
          ),
        );
      request.onsuccess = () => {
        const db = request.result;
        if (abandoned) {
          db.close();
          return;
        }
        if (
          db.objectStoreNames.length !== 1 ||
          !db.objectStoreNames.contains("workspace")
        ) {
          db.close();
          reject(
            new AppError("SAVE_FAILED", "学习空间结构不兼容，原记录已保留"),
          );
          return;
        }
        const table = db
          .transaction("workspace", "readonly")
          .objectStore("workspace");
        if (
          table.keyPath !== null ||
          table.autoIncrement ||
          table.indexNames.length
        ) {
          db.close();
          reject(
            new AppError("SAVE_FAILED", "学习空间表结构不兼容，原记录已保留"),
          );
          return;
        }
        resolve(new WorkspaceDb(db));
      };
    });
  }
  close() {
    this.closed = true;
    this.database.close();
  }
  private transaction(
    write: boolean,
    next?: Workspace,
    expected?: number | null,
  ): Promise<Workspace | null> {
    if (this.closed)
      return Promise.reject(
        new AppError("SAVE_FAILED", "学习空间连接已关闭，请重新打开应用"),
      );
    return new Promise((resolve, reject) => {
      let result: Workspace | null = null,
        failure: unknown;
      const tx = this.database.transaction(
        "workspace",
        write ? "readwrite" : "readonly",
      );
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          failure ??
            new AppError(
              "SAVE_FAILED",
              "保存失败，修改仍在本页，请检查空间并重试",
            ),
        );
      tx.onerror = () => {};
      const store = tx.objectStore("workspace"),
        get = store.get("current");
      get.onsuccess = () => {
        try {
          const previous =
            get.result === undefined ? null : parseWorkspace(get.result);
          if (!write) {
            result = previous;
            return;
          }
          if (
            (previous?.revision ?? null) !== expected ||
            next!.revision !== (expected ?? 0)
          )
            throw new AppError(
              "VERSION_CONFLICT",
              "其他窗口已保存新记录，本页修改未覆盖它；请先导出本页内容再重新打开",
            );
          if (previous) validateWorkspaceUpdate(previous, next!);
          result = parseWorkspace({
            ...next!,
            revision: previous ? previous.revision + 1 : 0,
          });
          store.put(result, "current");
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
    });
  }
  load() {
    return this.transaction(false);
  }
  save(next: Workspace, expectedRevision: number | null): Promise<Workspace> {
    return this.transaction(
      true,
      parseWorkspace(next),
      expectedRevision,
    ) as Promise<Workspace>;
  }
}
