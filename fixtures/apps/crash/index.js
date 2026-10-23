// Crash fixture: starts, then throws an unhandled error after 2 seconds (CrashLoopBackOff).
const http = require('http');
const port = Number(process.env.PORT) || 3000;
http.createServer((req, res) => res.end('ok')).listen(port, () => console.log(`crash fixture listening on port ${port}`));
setTimeout(() => {
  const order = undefined;
  console.log(order.id);
}, 2000);
