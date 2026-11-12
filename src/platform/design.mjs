import { createServer, build } from "vite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// 设计入口与正式学习页面隔离；示例文件必须由启动者明确指定，不进入源码。
const root = fileURLToPath(new URL("../design/", import.meta.url));
if (process.argv[2] === "--build") {
  await build({
    root,
    build: { outDir: "../../design-dist", emptyOutDir: true },
    logLevel: "warn",
  });
} else {
  const bank = process.argv[2] ? resolve(process.argv[2]) : null;
  const server = await createServer({
    root,
    server: { host: "127.0.0.1", port: 4175, strictPort: true },
    plugins: [
      {
        name: "explicit-design-bank",
        configureServer(server) {
          server.middlewares.use(
            "/design-bank.json",
            async (request, response) => {
              response.setHeader("Cache-Control", "no-store");
              response.setHeader(
                "Content-Type",
                "application/json; charset=utf-8",
              );
              if (request.method !== "GET") {
                response.statusCode = 405;
                response.end();
                return;
              }
              if (!bank) {
                response.statusCode = 204;
                response.end();
                return;
              }
              try {
                response.end(await readFile(bank));
              } catch {
                response.statusCode = 404;
                response.end();
              }
            },
          );
        },
      },
    ],
  });
  await server.listen();
  server.printUrls();
}
