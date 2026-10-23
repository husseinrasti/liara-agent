// Chaos demo app — the subject of the demo video. Behaviour is chosen by CHAOS_MODE
// (env var) or by a chaos.json baked into the release (`npm run chaos -- <mode> --deploy`):
//   none | leak | crash | slow | missing-env | error500
const fs = require('fs');
const http = require('http');
const path = require('path');

const port = Number(process.env.PORT) || 3000;

function bakedMode() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'chaos.json'), 'utf8')).mode || 'none';
  } catch {
    return 'none';
  }
}

const mode = process.env.CHAOS_MODE || bakedMode();
const products = [
  { id: 1, name: 'کتاب برنامه‌نویسی', price: 450000 },
  { id: 2, name: 'ماگ قهوه', price: 180000 },
  { id: 3, name: 'هدفون', price: 1250000 },
];

// leak: retain ~20 MB per second (off-heap buffers count against the container limit).
const retained = [];
if (mode === 'leak') {
  setInterval(() => retained.push(Buffer.alloc(20 * 1024 * 1024, 1)), 1000);
  setInterval(() => console.log(`memory usage: ${Math.round(process.memoryUsage().rss / 1048576)} MB`), 5000);
}

// crash: an unhandled error shortly after start-up → CrashLoopBackOff.
if (mode === 'crash') {
  setTimeout(() => {
    throw new Error("Unhandled: cannot read properties of undefined (reading 'id')");
  }, 3000);
}

function busy(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) Math.sqrt(Math.random());
}

function page() {
  const time = new Date().toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' });
  const items = products.map((p) => `<li>${p.name} — ${p.price.toLocaleString('fa-IR')} تومان</li>`).join('');
  return `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>فروشگاه نمونه</title>
<body style="font-family:Tahoma,sans-serif;max-width:640px;margin:40px auto;line-height:2">
<h1>فروشگاه نمونه</h1><p>ساعت: ${time}</p><ul>${items}</ul></body></html>`;
}

function handle(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, mode }));
  }
  if (mode === 'missing-env' && !process.env.PAYMENT_API_KEY) {
    console.error('Error: PAYMENT_API_KEY is not set');
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Internal Server Error');
  }
  if (req.url === '/api/products') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(products));
  }
  if (mode === 'error500') {
    const order = undefined;
    return res.end(String(order.price)); // throws TypeError → 500 below
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page());
}

http
  .createServer((req, res) => {
    const started = Date.now();
    const finish = () => console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    const run = () => {
      try {
        handle(req, res);
      } catch (err) {
        console.error(err.stack);
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Internal Server Error');
      }
      finish();
    };
    if (mode === 'slow') {
      busy(300);
      setTimeout(run, 2500 + Math.random() * 1500);
    } else {
      run();
    }
  })
  .listen(port, () => console.log(`demo app listening on port ${port} (mode: ${mode})`));
