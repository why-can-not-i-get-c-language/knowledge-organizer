import { Channel, invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { AppError } from "../domain/contracts.ts";
import type {
  AIProvider,
  AIEvent,
  DeepSeekConnection,
} from "../application/ports.ts";
import { aiMessages, DeepSeekEvents } from "../application/deepseek.ts";

const settingsSchema = z
  .object({
    configured: z.boolean(),
    model: z.string().min(1).max(100),
    maxOutputTokens: z.number().int().min(256).max(16384),
  })
  .strict();
function friendly(error: unknown): AppError {
  const code = String(error);
  const messages: Record<string, string> = {
    AUTH: "密钥无效，请在DeepSeek设置中重新填写。",
    BALANCE: "DeepSeek API余额不足，请在官方平台充值后重试。",
    RATE_LIMIT: "请求过于频繁，请稍后重试。",
    CANCELLED: "已停止，收到的内容已保留。",
    TIMEOUT: "等待超时，收到的内容已保留；可稍后手动重试。",
    NO_KEY: "请先在DeepSeek设置中填写自己的API Key。",
    BUSY: "已有回答正在生成，请先停止或等待。",
    INVALID_INPUT: "请求设置不合适，请检查模型和输出上限。",
    SECRET: "无法读取安全保存的密钥，请在设置中重新填写。",
  };
  return new AppError(
    code === "CANCELLED" ? "CANCELLED" : "NETWORK",
    messages[code] ?? "暂时无法连接DeepSeek，请检查网络后手动重试。",
  );
}
export class TauriDeepSeek implements AIProvider, DeepSeekConnection {
  async settings() {
    try {
      return settingsSchema.parse(await invoke("deepseek_settings"));
    } catch (e) {
      throw friendly(e);
    }
  }
  async configure(model: string, maxOutputTokens: number, key?: string) {
    try {
      await invoke("deepseek_configure", {
        model,
        maxOutputTokens,
        key: key ?? null,
      });
    } catch (e) {
      throw friendly(e);
    }
  }
  async setDeepSeekKey(value: string) {
    const s = await this.settings();
    await this.configure(s.model, s.maxOutputTokens, value);
  }
  async hasDeepSeekKey() {
    return (await this.settings()).configured;
  }
  async removeDeepSeekKey() {
    try {
      await invoke("deepseek_remove_key");
    } catch (e) {
      throw friendly(e);
    }
  }
  async checkConnection() {
    try {
      await invoke("deepseek_check");
    } catch (e) {
      throw friendly(e);
    }
  }
  async *stream(
    request: Parameters<AIProvider["stream"]>[0],
    signal: AbortSignal,
  ): AsyncIterable<AIEvent> {
    const messages = aiMessages(request),
      id = crypto.randomUUID(),
      parser = new DeepSeekEvents();
    let ended = false,
      error: unknown,
      wake: (() => void) | undefined;
    const queue: AIEvent[] = [];
    const channel = new Channel<{ data?: string; eof?: boolean }>();
    channel.onmessage = (event) => {
      if (ended) return;
      try {
        if (typeof event.data === "string")
          queue.push(...parser.parse(event.data));
        if (event.eof) {
          ended = true;
          if (!parser.done)
            error = new AppError("NETWORK", "连接中断，收到的内容已保留。");
        }
      } catch (e) {
        error = e;
        ended = true;
      }
      wake?.();
    };
    const abort = () => {
      ended = true;
      error = new AppError("CANCELLED", "已停止，收到的内容已保留。");
      void invoke("deepseek_cancel", { id }).catch(() => {});
      wake?.();
    };
    if (signal.aborted) throw new AppError("CANCELLED", "已停止。");
    signal.addEventListener("abort", abort, { once: true });
    const running = invoke("deepseek_stream", {
      id,
      model: request.model,
      maxOutputTokens: request.maxOutputTokens,
      messages,
      onEvent: channel,
    }).catch((e) => {
      if (!ended) {
        error = friendly(e);
        ended = true;
        wake?.();
      }
    });
    try {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (error) throw error;
        if (ended) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      signal.removeEventListener("abort", abort);
      void invoke("deepseek_cancel", { id }).catch(() => {});
      void running;
    }
  }
}
