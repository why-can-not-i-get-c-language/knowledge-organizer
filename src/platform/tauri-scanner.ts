import { invoke } from "@tauri-apps/api/core";
import { quizScanSchema, MAX_BANK_BYTES } from "../domain/contracts.ts";
import type { QuizScanner } from "../application/ports.ts";
export class TauriQuizScanner implements QuizScanner {
  async scan() {
    return quizScanSchema.parse(await invoke("scan_device"));
  }
  async read(path: string): Promise<string> {
    const text = await invoke<string>("read_scanned_file", { path });
    if (new TextEncoder().encode(text).length > MAX_BANK_BYTES)
      throw new Error("题集太大，请选择较小的文件");
    return text;
  }
  async cancel() {
    await invoke("cancel_device_scan");
  }
}
