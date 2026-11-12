import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仅交付已构建静态页面，以及显式指定的本地练习文件；不暴露项目目录。
const root = resolve(fileURLToPath(new URL('../../dist/', import.meta.url)));
const bankFile = process.argv[2] ? resolve(process.argv[2]) : null;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405); response.end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (path !== root && !path.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
    const isBank = pathname === '/prototype-bank.json';
    if (isBank && !bankFile) { response.writeHead(204); response.end(); return; }
    const bytes = await readFile(isBank ? bankFile : path);
    response.setHeader('Content-Type', types[isBank ? '.json' : extname(path)] || 'application/octet-stream');
    response.writeHead(200); response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch { response.writeHead(404); response.end('未找到页面或资源'); }
});
server.listen(port, host, () => console.log(`选文原型：http://${host}:${port}`));
server.on('error', error => { console.error(`原型启动失败：${error.message}`); process.exitCode = 1; });
