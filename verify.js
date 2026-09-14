#!/usr/bin/env node
/* =============================================================================
   verify.js — PrintLapse 的判卷脚本
   起本地服务 + 无头 Chrome，像用户一样操作界面：往文件框里放样本、改下拉框、点「导出视频」，
   收下浏览器真正下载的文件，再只用 ffprobe 和抽帧像素判定。页面自己报的数字一概不信。

     node verify.js                       正常判卷，全过打印 VERIFY PASS，退出码 0
     node verify.js --prove               把样本里所有 E 参数删掉再喂（=--break=noE），必须 VERIFY FAIL
     node verify.js --break=flat          只留第一层的挤出、后面的 E 全删（页面能打开但模型不再长高），生长判据必须变红
     node verify.js --break=onecolor      bearing4c 的耗材颜色全改成 #FF0000，颜色判据必须变红
     node verify.js --break=samecam       三机位用例全用同一个机位，机位判据必须变红
     node verify.js --url https://...     判线上页面而不是本地文件
     node verify.js --only=growth,cams    只跑某几组（调试用；判卷时不许带）
   ============================================================================= */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname;
const WORK = path.join(ROOT, '.work');
const OUT = path.join(WORK, 'verify-out');
const BROKEN = path.join(WORK, 'broken');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8947;

const argv = process.argv.slice(2);
const arg = k => { const a = argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : null; };
const BREAK = argv.includes('--prove') ? 'noE' : arg('break');
const URL_ARG = arg('url');
const ONLY = arg('only') ? arg('only').split(',') : null;
if(BREAK && !['noE', 'flat', 'onecolor', 'samecam'].includes(BREAK)){ console.log('不认识的 --break=' + BREAK); process.exit(2); }

const FIX = {
  cube: path.join(ROOT, 'fixtures', 'cube.gcode.3mf'),
  bearing: path.join(ROOT, 'fixtures', 'bearing4c.gcode.3mf'),
  tower: path.join(ROOT, 'fixtures', 'tower.gcode.3mf'),
  unsliced: 'D:\\blender\\6210_print\\6210_Cage_free.3mf'
};

/* ---------------------------------------------------------------------------
   判卷标准。任务 3 做完后冻结（sha256 记在 PROGRESS.md），之后改动要进 BLOCKED.md。
   --------------------------------------------------------------------------- */
const HOLD_SECONDS = 1;                 // 片尾停留，算在总时长里
const J = (name, o) => Object.assign({ name, mode: 'smooth', camera: 'fixed', zoom: 45 }, o);

// a) 矩阵：五种清晰度、三种帧率、六种比例、两种格式，每个值至少真导出一次
const MATRIX = [
  J('m_480_16x9_24_mp4',   { ratio: '16:9', res: 480,  fps: 24, seconds: 2, format: 'mp4',  w: 854,  h: 480 }),
  J('m_720_9x16_30_webm',  { ratio: '9:16', res: 720,  fps: 30, seconds: 2, format: 'webm', w: 720,  h: 1280 }),
  J('m_1080_1x1_60_mp4',   { ratio: '1:1',  res: 1080, fps: 60, seconds: 2, format: 'mp4',  w: 1080, h: 1080 }),
  J('m_1440_4x5_24_mp4',   { ratio: '4:5',  res: 1440, fps: 24, seconds: 2, format: 'mp4',  w: 1440, h: 1800 }),
  J('m_2160_16x9_30_mp4',  { ratio: '16:9', res: 2160, fps: 30, seconds: 2, format: 'mp4',  w: 3840, h: 2160 }),
  J('m_720_4x3_60_webm',   { ratio: '4:3',  res: 720,  fps: 60, seconds: 3, format: 'webm', w: 960,  h: 720 }),
  J('m_1080_21x9_30_mp4',  { ratio: '21:9', res: 1080, fps: 30, seconds: 2, format: 'mp4',  w: 2520, h: 1080, mode: 'continuous' }),
];
// b) 逐层生长与颜色（任务 2）
const GROWTH = J('growth_bearing', { ratio: '16:9', res: 720, fps: 30, seconds: 4, format: 'mp4', w: 1280, h: 720, zoom: 70 });
const GROWTH_PCTS = [0, 25, 50, 75, 100];
const GROWTH_STEP_MIN = 0.10;
const RED_MIN_RATIO = 0.004, BLUE_MIN_RATIO = 0.0008;
// c) 三机位（任务 3）
const CAMS = ['fixed', 'orbit', 'top'].map(c =>
  J('cam_' + c, { ratio: '16:9', res: 480, fps: 24, seconds: 3, format: 'mp4', w: 854, h: 480, zoom: 30,
                  camera: BREAK === 'samecam' ? 'fixed' : c }));
const CAM_DIFF_MIN = 0.12;
// d) 大文件性能（任务 3，阈值是猜的）
const TOWER = J('tower_1080_30_10s', { ratio: '16:9', res: 1080, fps: 30, seconds: 10, format: 'mp4', w: 1920, h: 1080, zoom: 40 });
const TOWER_LOAD_MAX_S = 30, TOWER_EXPORT_MAX_S = 300;

/* 模型长出来了：末帧比首帧（空床）多出的鲜艳像素占比。
   不用"像素变了多少"：实测 cube 用例里横梁随 Z 升高本身就让 10% 像素变化，模型一根丝不画也能过。 */
const MODEL_SAT_GAIN_MIN = 0.001;
const UNIQUE_COLORS_MIN = 256;         // 挡黑屏、纯色

/* --------------------------------------------------------------------------- */
const log = (...a) => console.log(...a);
const fails = [];
function check(cond, msg){
  log((cond ? '  [ok]   ' : '  [FAIL] ') + msg);
  if(!cond) fails.push(msg);
  return cond;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 视频文件检查：只信 ffprobe 和像素 ---------- */
function probe(file){
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-print_format', 'json', '-show_streams', file], { maxBuffer: 1 << 26 }).toString());
  return (j.streams || []).find(s => s.codec_type === 'video');
}
function frameRGB(file, n, w, h){
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1',
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  if(buf.length < w * h * 3) throw new Error(`第 ${n} 帧只抽到 ${buf.length} 字节`);
  return buf.subarray(0, w * h * 3);
}
function uniqueColors(buf){
  const s = new Set();
  for(let i = 0; i < buf.length; i += 3) s.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
  return s.size;
}
function diffRatio(a, b){
  let n = 0;
  for(let i = 0; i < a.length; i += 3){
    if(Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 48) n++;
  }
  return n / (a.length / 3);
}
/* 鲜艳像素统计：打印机、热床、背景全是灰黑色，鲜艳的只有模型（和颜色固定不变的料盘） */
function colourStats(buf){
  let sat = 0, red = 0, blue = 0;
  const total = buf.length / 3;
  for(let i = 0; i < buf.length; i += 3){
    const r = buf[i], g = buf[i + 1], b = buf[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if(mx < 64 || (mx - mn) / mx < 0.5) continue;
    sat++;
    let h;
    const d = mx - mn;
    if(mx === r) h = 60 * (((g - b) / d) % 6); else if(mx === g) h = 60 * ((b - r) / d + 2); else h = 60 * ((r - g) / d + 4);
    if(h < 0) h += 360;
    if(h <= 16 || h >= 344) red++;
    else if(h >= 200 && h <= 240) blue++;
  }
  return { sat, red: red / total, blue: blue / total };
}
function checkFile(job, file){
  if(!check(fs.existsSync(file), `${job.name}：下载到了视频文件`)) return null;
  let st;
  try{ st = probe(file); }catch(e){ check(false, `${job.name}：ffprobe 读不了（${String(e.message).slice(0, 80)}）`); return null; }
  if(!check(!!st, `${job.name}：文件里有视频流`)) return null;
  const codec = job.format === 'mp4' ? 'h264' : 'vp9';
  const frames = Math.round(job.fps * job.seconds);
  check(st.codec_name === codec, `${job.name}：编码 ${codec}（读到 ${st.codec_name}）`);
  check(st.width === job.w && st.height === job.h, `${job.name}：尺寸 ${job.w}x${job.h}（读到 ${st.width}x${st.height}）`);
  check(st.r_frame_rate === job.fps + '/1', `${job.name}：帧率 ${job.fps}（读到 ${st.r_frame_rate}）`);
  check(+st.nb_read_frames === frames, `${job.name}：帧数 ${frames}=${job.fps}x${job.seconds}s（数出来 ${st.nb_read_frames}）`);
  return { st, frames };
}

/* ---------- 样本改造（反向验证用），在 .work/broken 下生成，原样本不动 ---------- */
function readZip(buf){
  let eocd = -1;
  for(let i = buf.length - 22; i >= 0; i--) if(buf.readUInt32LE(i) === 0x06054b50){ eocd = i; break; }
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for(let k = 0; k < count; k++){
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const lnl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28);
    const raw = buf.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + csize);
    files.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw) });
    p += 46 + nl + el + cl;
  }
  return files;
}
function writeZip(files){
  const locals = [], centrals = [];
  let offset = 0;
  for(const f of files){
    const name = Buffer.from(f.name, 'utf8'), comp = zlib.deflateRawSync(f.data), crc = zlib.crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp); centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function brokenCopy(src, kind){
  fs.mkdirSync(BROKEN, { recursive: true });
  const files = readZip(fs.readFileSync(src));
  for(const f of files){
    const stripE = t => t.replace(/^(G[0-3](?:\s[^;\n]*?)?)\sE-?[\d.]+/gm, '$1');
    if(kind === 'noE' && /^Metadata\/plate_\d+\.gcode$/.test(f.name)){
      f.data = Buffer.from(stripE(f.data.toString('utf8')), 'utf8');
    }
    if(kind === 'flat' && /^Metadata\/plate_\d+\.gcode$/.test(f.name)){
      const t = f.data.toString('utf8');
      const first = t.indexOf('; CHANGE_LAYER'), second = t.indexOf('; CHANGE_LAYER', first + 1);
      f.data = Buffer.from(t.slice(0, second) + stripE(t.slice(second)), 'utf8');
    }
    if(kind === 'onecolor'){
      if(f.name === 'Metadata/project_settings.config'){
        const j = JSON.parse(f.data.toString('utf8'));
        j.filament_colour = j.filament_colour.map(() => '#FF0000');
        f.data = Buffer.from(JSON.stringify(j, null, 4), 'utf8');
      }
      if(/^Metadata\/plate_\d+\.gcode$/.test(f.name)){
        f.data = Buffer.from(f.data.toString('utf8').replace(/^; filament_colour = .*$/m, m => m.replace(/#[0-9A-Fa-f]{6}/g, '#FF0000')), 'utf8');
      }
    }
  }
  const out = path.join(BROKEN, kind + '_' + path.basename(src));
  fs.writeFileSync(out, writeZip(files));
  return out;
}

/* ---------- 极简 CDP 客户端 ---------- */
class CDP {
  constructor(ws){ this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = []; }
  static async connect(url){
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if(m.id && c.pending.has(m.id)){
        const { resolve, reject } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }else if(m.method){ for(const l of c.listeners) l(m); }
    };
    return c;
  }
  send(method, params = {}, sessionId){
    const id = ++this.id;
    this.ws.send(JSON.stringify(Object.assign({ id, method, params }, sessionId ? { sessionId } : {})));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn){ this.listeners.push(fn); }
}

class Page {
  constructor(cdp, sid){ this.cdp = cdp; this.sid = sid; }
  send(m, p){ return this.cdp.send(m, p, this.sid); }
  async eval(expr){
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if(r.exceptionDetails) throw new Error('页面脚本出错：' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    return r.result.value;
  }
  async waitState(states, timeoutMs){
    const t0 = Date.now();
    while(Date.now() - t0 < timeoutMs){
      const s = await this.eval('document.body && document.body.dataset.state');
      if(states.includes(s)) return s;
      await sleep(250);
    }
    return 'timeout';
  }
  async open(url){
    await this.send('Page.navigate', { url });
    await sleep(500);
    return this.waitState(['empty'], 30000);
  }
  async setFile(file){
    const doc = await this.send('DOM.getDocument', {});
    const q = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    await this.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [file] });
  }
  async setControls(job){
    const vals = { mode: job.mode, camera: job.camera, ratio: job.ratio, res: String(job.res), fps: String(job.fps),
                   seconds: String(job.seconds), format: job.format, zoom: String(job.zoom) };
    return this.eval(`(() => { const v = ${JSON.stringify(vals)}; const bad = [];
      for(const k in v){ const el = document.getElementById(k); if(!el){ bad.push(k); continue; }
        el.value = v[k]; if(el.value !== v[k]) bad.push(k + '=' + v[k]);
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      return bad; })()`);
  }
}

/* ---------- 主流程 ---------- */
async function main(){
  // 只清里面的文件，不删目录本身（有终端停在这个目录里时 Windows 不让删）
  fs.mkdirSync(OUT, { recursive: true });
  for(const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { recursive: true, force: true });
  const title = BREAK ? `=== 反向验证：--break=${BREAK}（这一轮应该 VERIFY FAIL）===` : '=== PrintLapse 判卷 ===';
  log(title);

  let server = null, base = URL_ARG;
  if(!base){
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
    server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if(!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){ res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    });
    await new Promise(r => server.listen(PORT, r));
    base = `http://localhost:${PORT}/`;
  }
  log('页面：' + base);

  // 每轮一个独立的浏览器配置目录：上一轮 Chrome 退得慢时目录还锁着，共用一个会让脚本自己崩掉，
  // 而崩掉的退出码如果也是 1，就会冒充"判据变红"（实测踩过一次）
  for(const d of fs.readdirSync(WORK)) if(d.startsWith('chrome-verify')){ try{ fs.rmSync(path.join(WORK, d), { recursive: true, force: true }); }catch(e){} }
  const profile = path.join(WORK, 'chrome-verify-' + process.pid);
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--mute-audio', '--remote-debugging-port=0',
    '--disable-component-update', '--user-data-dir=' + profile, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  let port = null;
  for(let k = 0; k < 100 && !port; k++){
    await sleep(200);
    try{ port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); }catch(e){}
  }
  if(!port){ log('无头 Chrome 没起来'); process.exit(1); }
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = await CDP.connect(ver.webSocketDebuggerUrl);

  const downloads = new Map();   // guid -> { state }
  cdp.on(m => {
    if(m.method === 'Browser.downloadWillBegin') downloads.set(m.params.guid, { state: 'begin', name: m.params.suggestedFilename });
    if(m.method === 'Browser.downloadProgress' && downloads.has(m.params.guid)) downloads.get(m.params.guid).state = m.params.state;
  });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: OUT, eventsEnabled: true });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(cdp, sessionId);
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('DOM.enable');
  const pageErrors = [];
  cdp.on(m => { if(m.sessionId === sessionId && m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text); });

  async function load(file, label){
    await page.open(base);
    const t0 = Date.now();
    await page.setFile(file);
    const s = await page.waitState(['ready', 'error'], 180000);
    const secs = (Date.now() - t0) / 1000;
    const msg = await page.eval(`document.getElementById('status').textContent`);
    log(`  载入 ${label}：${s}，${secs.toFixed(1)} 秒${s !== 'ready' ? '，页面提示：' + String(msg).slice(0, 120) : ''}`);
    return { state: s, secs, msg };
  }
  async function exportJob(job){
    const bad = await page.setControls(job);
    if(bad.length){ check(false, `${job.name}：界面上设不了 ${bad.join(', ')}`); return null; }
    const before = new Set(downloads.keys());
    const t0 = Date.now();
    await page.eval(`document.getElementById('export').click()`);
    let guid = null;
    while(Date.now() - t0 < 15 * 60000){
      for(const [g, d] of downloads) if(!before.has(g) && d.state === 'completed') guid = g;
      if(guid) break;
      const s = await page.eval('document.body.dataset.state');
      if(s === 'error'){ break; }
      await sleep(300);
    }
    const secs = (Date.now() - t0) / 1000;
    if(!guid){
      const msg = await page.eval(`document.getElementById('status').textContent`);
      check(false, `${job.name}：没有导出成文件（页面提示：${String(msg).slice(0, 100)}）`);
      return null;
    }
    const dst = path.join(OUT, job.name + '.' + job.format);
    fs.renameSync(path.join(OUT, guid), dst);
    log(`  导出 ${job.name}：${secs.toFixed(1)} 秒，${(fs.statSync(dst).size / 1048576).toFixed(2)} MB`);
    return { file: dst, secs };
  }
  const want = g => !ONLY || ONLY.includes(g);
  const fx = k => ((BREAK === 'noE' || BREAK === 'flat') && k !== 'unsliced') ? brokenCopy(FIX[k], BREAK)
               : (BREAK === 'onecolor' && k === 'bearing') ? brokenCopy(FIX[k], 'onecolor') : FIX[k];

  try{
    /* a) 矩阵 */
    if(want('matrix')){
      log('\n--- a) 清晰度 × 帧率 × 比例 × 格式 × 拍法（cube 样本）---');
      const l = await load(fx('cube'), 'cube');
      if(check(l.state === 'ready', 'cube 样本载入成功')){
        for(const job of MATRIX){
          const r = await exportJob(job);
          if(!r) continue;
          const info = checkFile(job, r.file);
          if(!info) continue;
          const first = frameRGB(r.file, 0, job.w, job.h), last = frameRGB(r.file, info.frames - 1, job.w, job.h);
          const u = uniqueColors(last);
          check(u >= UNIQUE_COLORS_MIN, `${job.name}：末帧 ${u} 种颜色（要 ≥${UNIQUE_COLORS_MIN}，挡黑屏）`);
          const gain = (colourStats(last).sat - colourStats(first).sat) / (job.w * job.h);
          check(gain >= MODEL_SAT_GAIN_MIN, `${job.name}：末帧比首帧多出 ${(gain * 100).toFixed(2)}% 模型色像素（要 ≥${MODEL_SAT_GAIN_MIN * 100}%）`);
        }
      }
    }

    /* b) 拒收没切片的 3mf */
    if(want('reject')){
      log('\n--- b) 没切片的 3mf 必须被拒 ---');
      const l = await load(FIX.unsliced, '6210_Cage_free.3mf');
      check(l.state === 'error', `页面进入报错状态（实际 ${l.state}）`);
      check(/切片/.test(l.msg) && /Bambu Studio/.test(l.msg), `报错里告诉用户去 Bambu Studio 切片导出（提示：${String(l.msg).slice(0, 40)}…）`);
      const disabled = await page.eval(`document.getElementById('export').disabled`);
      check(disabled === true, '导出按钮不可点');
      const before = downloads.size;
      await page.eval(`document.getElementById('export').click()`);
      await sleep(4000);
      check(downloads.size === before, `硬点一下导出，4 秒内页面没有发起任何下载（新增 ${downloads.size - before} 个）`);
    }

    /* c) 逐层生长 + 颜色 */
    if(want('growth')){
      log('\n--- c) 逐层生长与耗材颜色（bearing4c 四色样本，平滑延时、固定机位）---');
      const l = await load(fx('bearing'), 'bearing4c');
      const r = check(l.state === 'ready', 'bearing4c 样本载入成功') ? await exportJob(GROWTH) : null;
      const info = r && checkFile(GROWTH, r.file);
      if(info){
        const growN = info.frames - GROWTH.fps * HOLD_SECONDS;
        const stats = GROWTH_PCTS.map(p => {
          const n = Math.round(p / 100 * (growN - 1));
          const s = colourStats(frameRGB(r.file, n, GROWTH.w, GROWTH.h));
          log(`  ${String(p).padStart(3)}%（第 ${n} 帧）：鲜艳像素 ${s.sat}，红 ${(s.red * 100).toFixed(2)}%，蓝 ${(s.blue * 100).toFixed(2)}%`);
          return s;
        });
        /* 光"严格递增"不够：实测只留第一层挤出（--break=flat）时，横梁随 Z 升高让第一层露出得更多，
           数字照样 0<3394<3559<3689<3751 地涨。所以要求每一档都比上一档多出至少 GROWTH_STEP_MIN。
           正常样本实测 +37%/+29%/+23%，flat 只有 +5%/+4%/+2%。 */
        const steps = stats.slice(1).map((s, k) => k === 0 ? (s.sat > 0 ? Infinity : 0) : s.sat / Math.max(1, stats[k].sat) - 1);
        const inc = stats[0].sat < stats[1].sat && steps.every(g => g >= GROWTH_STEP_MIN);
        check(inc, `模型色像素随进度明显增长（25% 之后每档至少 +${GROWTH_STEP_MIN * 100}%）：${stats.map(s => s.sat).join(' → ')}，` +
                   `增幅 ${steps.slice(1).map(g => '+' + (g * 100).toFixed(0) + '%').join(' / ')}`);
        const lastS = colourStats(frameRGB(r.file, info.frames - 1, GROWTH.w, GROWTH.h));
        check(lastS.red >= RED_MIN_RATIO, `末帧找得到红色耗材 ${(lastS.red * 100).toFixed(2)}%（要 ≥${RED_MIN_RATIO * 100}%）`);
        check(lastS.blue >= BLUE_MIN_RATIO, `末帧找得到蓝色耗材 ${(lastS.blue * 100).toFixed(3)}%（要 ≥${BLUE_MIN_RATIO * 100}%）`);
      }

      /* d) 三机位 —— 同一个样本，接着导 */
      if(want('cams') && l.state === 'ready'){
        log('\n--- d) 三个机位互相不是同一个画面 ---');
        const mids = {};
        for(const job of CAMS){
          const rr = await exportJob(job);
          const ii = rr && checkFile(job, rr.file);
          if(ii) mids[job.name] = frameRGB(rr.file, Math.floor(ii.frames / 2), job.w, job.h);
        }
        const names = Object.keys(mids);
        check(names.length === 3, `三个机位都导出来了（${names.length}/3）`);
        for(let a = 0; a < names.length; a++) for(let b = a + 1; b < names.length; b++){
          const dr = diffRatio(mids[names[a]], mids[names[b]]);
          check(dr >= CAM_DIFF_MIN, `${names[a]} vs ${names[b]}：中间帧 ${(dr * 100).toFixed(1)}% 像素不同（要 ≥${CAM_DIFF_MIN * 100}%）`);
        }
      }
    }else if(want('cams')){
      log('\n--- d) 三个机位互相不是同一个画面 ---');
      check(false, 'cams 组依赖 growth 组的样本载入，请一起跑');
    }

    /* e) 大文件性能 */
    if(want('tower')){
      log('\n--- e) tower 大样本（750 层）：打开速度与 1080p30 10 秒导出速度 ---');
      const l = await load(fx('tower'), 'tower');
      check(l.state === 'ready', 'tower 样本载入成功');
      check(l.secs <= TOWER_LOAD_MAX_S, `打开到可导出 ${l.secs.toFixed(1)} 秒（要 ≤${TOWER_LOAD_MAX_S}）`);
      if(l.state === 'ready'){
        const r = await exportJob(TOWER);
        if(r){
          check(r.secs <= TOWER_EXPORT_MAX_S, `导出用时 ${r.secs.toFixed(1)} 秒（要 ≤${TOWER_EXPORT_MAX_S}）`);
          const info = checkFile(TOWER, r.file);
          if(info){
            const gain = (colourStats(frameRGB(r.file, info.frames - 1, TOWER.w, TOWER.h)).sat - colourStats(frameRGB(r.file, 0, TOWER.w, TOWER.h)).sat) / (TOWER.w * TOWER.h);
            check(gain >= MODEL_SAT_GAIN_MIN, `末帧比首帧多出 ${(gain * 100).toFixed(2)}% 模型色像素（要 ≥${MODEL_SAT_GAIN_MIN * 100}%）`);
          }
        }
      }
    }

    check(pageErrors.length === 0, `页面没有抛出未捕获的异常（${pageErrors.length} 个${pageErrors.length ? '：' + pageErrors[0].slice(0, 80) : ''}）`);
  }finally{
    if(process.env.PL_DEBUG) for(const [g, d] of downloads) log('  [debug] download', g, d.state, d.name);
    try{ await cdp.send('Browser.close'); }catch(e){}
    try{ chrome.kill(); }catch(e){}
    await Promise.race([new Promise(r => chrome.once('exit', r)), sleep(5000)]);
    if(server) server.close();
  }

  log('');
  if(ONLY) log('注意：带了 --only，只跑了部分用例，这一轮不能当判卷结果。');
  if(fails.length){
    log(`VERIFY FAIL：${fails.length} 项没过`);
    for(const f of fails) log('  - ' + f);
    process.exit(1);
  }
  if(ONLY){ log('VERIFY PARTIAL（--only）'); process.exit(3); }
  log('VERIFY PASS');
  process.exit(0);
}

main().catch(e => { console.log('verify.js 自身出错（不是判卷结果）：' + (e.stack || e)); process.exit(2); });
