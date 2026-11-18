'use strict';
const { parentPort, workerData } = require('worker_threads');
const { argon2id } = require('hash-wasm');
(async () => {
  const password = new Uint8Array(workerData.password), salt = new Uint8Array(workerData.salt);
  let key;
  try {
    // Fixed, reviewed parameters. No file-provided parameter can raise this
    // worker's memory or CPU budget. A fresh worker discards all WASM memory.
    key = await argon2id({ password, salt, memorySize: 262144, iterations: 3, parallelism: 1, hashLength: 32, outputType: 'binary' });
    parentPort.postMessage({ ok: true, key }, [key.buffer]);
  } catch { parentPort.postMessage({ ok: false }); }
  finally {
    password.fill(0); salt.fill(0);
    if (key?.buffer.byteLength) key.fill(0);
    parentPort.close();
  }
})().catch(() => process.exit(1));
