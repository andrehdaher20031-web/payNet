const orders = require('./alraghebOrder.service');
let timer;
let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try { await orders.reconcile(); }
  catch { console.error('Alragheb reconciliation unavailable; pending orders retained'); }
  finally { running = false; }
};
const start = () => {
  if (timer) return;
  timer = setInterval(tick, 30000);
  timer.unref();
  void tick();
};
const stop = () => { clearInterval(timer); timer = null; };
module.exports = { start, stop };
