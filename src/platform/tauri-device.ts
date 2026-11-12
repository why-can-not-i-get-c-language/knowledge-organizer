import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile, stat } from '@tauri-apps/plugin-fs';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { AppError, MAX_BACKUP_BYTES } from '../domain/contracts.ts';
import type { DeviceServices } from '../application/ports.ts';

/** 原生宿主通过系统文件选择器授权单个文件，不请求整个存储目录权限。 */
export class TauriDeviceServices implements DeviceServices {
  async readImportFile(): Promise<string | null> {
    try {
      const path = await open({ multiple: false, directory: false, filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (path === null) return null;
      if ((await stat(path)).size > MAX_BACKUP_BYTES) throw new AppError('INVALID_INPUT', '文件超过50MiB，请缩小内容后重试');
      const text = await readTextFile(path);
      if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) throw new AppError('INVALID_INPUT', '文件超过50MiB，请缩小内容后重试');
      return text;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('INVALID_INPUT', '无法读取所选文件，请重新选择并允许读取');
    }
  }
  async writeExportFile(name: string, content: string): Promise<'saved' | 'cancelled'> {
    try {
      const path = await save({ defaultPath: name, filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (path === null) return 'cancelled';
      await writeTextFile(path, content); return 'saved';
    } catch { throw new AppError('SAVE_FAILED', '备份文件保存失败，请重新选择位置并检查权限'); }
  }
  async copyText(content: string): Promise<void> {
    try { await writeText(content); }
    catch { throw new AppError('CLIPBOARD_FAILED', '自动复制失败，请在文本预览中全选复制'); }
  }
}
