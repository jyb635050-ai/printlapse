#!/usr/bin/env node
/* screenshot.js — 用无头 Chrome 打开页面、载入样本、设好界面，截整页图（给人看效果用，不参与判卷）
     node tools/screenshot.js <样本> <输出.png> [camera=fixed] [scrub=0..1000] [ratio=16:9] [mode=smooth] [zoom=45]
*/
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const ROOT = path.dirname(__dirname);
const [file, out, camera = 'fixed', scrub = '1000', ratio = '16:9', mode = 'smooth', zoom = '45'] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if(!fs.existsSync(f) || fs.statSync(f).isDirectory()){ res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript'); res.end(fs.readFileSync(f));
  }).listen(8948);
  const profile = path.join(ROOT, '.work', 'chrome-shot');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-sandbox', '--disable-component-update',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });
  let port; for(let k = 0; k < 100 && !port; k++){ await sleep(200); try{ port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; }catch(e){} }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if(m.id && pend.has(m.id)){ pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.result.value;
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:8948/' }); await sleep(1500);
  const doc = await send('DOM.getDocument'); const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#file' });
  await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [path.resolve(file)] });
  for(let k = 0; k < 200; k++){ const s = await ev('document.body.dataset.state'); if(s === 'ready' || s === 'error') break; await sleep(200); }
  await ev(`(() => { const v = ${JSON.stringify({ camera, ratio, mode, zoom })};
    for(const k in v){ const el = document.getElementById(k); el.value = v[k]; el.dispatchEvent(new Event('change', { bubbles: true })); }
    const s = document.getElementById('scrub'); s.value = ${JSON.stringify(scrub)}; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(600);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('saved', out, 'state=' + await ev('document.body.dataset.state'), await ev(`document.getElementById('scrubInfo').textContent`));
  try{ await send('Browser.close'); }catch(e){} chrome.kill(); server.close(); process.exit(0);
})();
