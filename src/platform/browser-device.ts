import { AppError, MAX_BACKUP_BYTES } from '../domain/contracts.ts';
import type { DeviceServices } from '../application/ports.ts';

interface WritableFile { write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
interface SaveWindow extends Window {
  showSaveFilePicker?: (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable(): Promise<WritableFile> }>;
}
export class BrowserDeviceServices implements DeviceServices {
  readImportFile(): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
      document.body.append(input);
      const finish = () => input.remove();
      input.addEventListener('cancel', () => { finish(); resolve(null); }, { once: true });
      input.addEventListener('change', () => {
        const file = input.files?.[0]; finish();
        if (!file) { resolve(null); return; }
        if (file.size > MAX_BACKUP_BYTES) { reject(new AppError('INVALID_INPUT', '文件超过50MiB，请缩小内容后重试')); return; }
        void file.text().then(resolve, () => reject(new AppError('INVALID_INPUT', '文件无法读取，请重新选择文件')));
      }, { once: true });
      input.click();
    });
  }
  async writeExportFile(name: string, content: string): Promise<'saved' | 'download-requested' | 'cancelled'> {
    const picker = (window as SaveWindow).showSaveFilePicker;
    if (picker) {
      let stream: WritableFile | undefined;
      try {
        const handle = await picker.call(window, { suggestedName: name, types: [{ description: 'JSON文件', accept: { 'application/json': ['.json'] } }] });
        stream = await handle.createWritable(); await stream.write(content); await stream.close(); return 'saved';
      } catch (error) {
        if (stream) await stream.abort().catch(() => {});
        if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
        throw new AppError('SAVE_FAILED', '导出文件失败，请检查保存权限并重试');
      }
    }
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    return 'download-requested';
  }
  async copyText(content: string): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('无剪贴板');
      await navigator.clipboard.writeText(content);
    } catch { throw new AppError('CLIPBOARD_FAILED', '自动复制不可用，请在下方文本中全选复制'); }
  }
}
