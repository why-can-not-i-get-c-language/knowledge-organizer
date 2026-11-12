import { build } from 'vite';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../../', import.meta.url));
const root = resolve(project, 'dist');
await build({ root: resolve(project, 'src/design'), base: '/', logLevel: 'warn', build: { outDir: root, emptyOutDir: true } });
// 兼容0.2.0的启动路径；两个URL均加载同一个应用，不提供第二套页面。
await mkdir(resolve(root, 'design'), { recursive: true });
await writeFile(resolve(root, 'design/index.html'), await readFile(resolve(root, 'index.html')));
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]));
  return nested.flat();
}
const paths = (await files(root)).sort();
const hash = createHash('sha256');
const urls = [];
for (const path of paths) {
  const url = '/' + relative(root, path).replaceAll('\\', '/'); urls.push(url); hash.update(url); hash.update(await readFile(path));
}
const template = await readFile(resolve(project, 'src/platform/service-worker-template.js'), 'utf8');
hash.update(template);
const worker = template.replace("/*__CACHE__*/''", JSON.stringify('knowledge-organizer-shell-' + hash.digest('hex').slice(0, 16)))
  .replace('/*__PRECACHE__*/[]', JSON.stringify(urls));
await writeFile(resolve(root, 'sw.js'), worker);
console.log(`离线资源：${urls.length}项，已生成Service Worker。`);
