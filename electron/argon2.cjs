'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const TIMEOUT_MS = 30000;
function deriveArgon2id(password, salt, signal) {
  if (signal?.aborted) return Promise.reject(new Error('操作已因锁定而取消，请重新解锁'));
  return new Promise((resolve, reject) => {
    const passwordCopy = Uint8Array.from(password), saltCopy = Uint8Array.from(salt);
    let worker, timer, settled = false;
    const abort = () => finish(new Error('操作已因锁定而取消，请重新解锁'));
    const finish = async (error, key) => {
      if (settled) { key?.fill(0); return; }
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (worker) {
        worker.removeAllListeners(); worker.on('error', () => {});
        // Retain the caller's authentication slot until the old worker has
        // actually stopped and released its WASM memory, including on abort.
        await worker.terminate().catch(() => {});
      }
      if (passwordCopy.buffer.byteLength) passwordCopy.fill(0);
      if (saltCopy.buffer.byteLength) saltCopy.fill(0);
      if (!error && signal?.aborted) error = new Error('操作已因锁定而取消，请重新解锁');
      if (error) { key?.fill(0); reject(error); } else resolve(key);
    };
    try {
      worker = new Worker(path.join(__dirname, 'argon2-worker.cjs'), {
        workerData: { password: passwordCopy.buffer, salt: saltCopy.buffer },
        transferList: [passwordCopy.buffer, saltCopy.buffer],
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      timer = setTimeout(() => finish(new Error('密钥派生超时，请关闭其他占用内存的程序后重试')), TIMEOUT_MS);
      worker.once('message', result => {
        if (!result?.ok || !(result.key instanceof Uint8Array) || result.key.length !== 32) return finish(new Error('密钥派生未能完成，请重试'));
        const key = Buffer.from(result.key); result.key.fill(0); finish(null, key);
      });
      worker.once('error', () => finish(new Error('密钥派生未能完成，请重试')));
      worker.once('exit', () => { if (!settled) finish(new Error('密钥派生未能完成，请重试')); });
    } catch { finish(new Error('密钥派生未能完成，请重试')); }
  });
}
module.exports = { deriveArgon2id };
