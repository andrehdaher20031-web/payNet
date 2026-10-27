const orders = require('./alraghebOrder.service');
const operations = require('./providerOperations.service');
let timer;
let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try {
    await operations.recordWorkerHeartbeat('alragheb', { state: 'started', leaseMs: 600000 });
    const processed = await orders.reconcile();
    await operations.recordWorkerHeartbeat('alragheb', { state: 'succeeded', processed });
  }
  catch (error) {
    await operations.recordWorkerHeartbeat('alragheb', { state: 'failed', errorCode: operations.safeCode(error.code) }).catch(() => {});
    console.error('Alragheb reconciliation unavailable; pending orders retained');
  }
  finally { running = false; }
};
const start = () => {
  if (timer) return;
  timer = setInterval(tick, 30000);
  timer.unref();
  void tick();
};
const stop = () => { clearInterval(timer); timer = null; };
module.exports = { start, stop, tick };
