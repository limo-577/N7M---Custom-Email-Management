const path = require('path');
const { Worker } = require('worker_threads');

const LIMITS = Object.freeze({
  fileBytes: 20 * 1024 * 1024,
  entries: 512,
  entryBytes: 16 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  sheets: 30,
  rows: 50000,
  columns: 100,
  cells: 250000,
  characters: 4000000,
  cellCharacters: 32767
});
const ERRORS = Object.freeze({
  INVALID_XLSX: 'Excel 文件无效、损坏或使用了不支持的加密 / ZIP 格式，请另存为标准 .xlsx 后重试',
  LIMIT_FILE: 'Excel 文件请控制在 20 MB 以内',
  LIMIT_ENTRIES: 'Excel 内部文件数量过多，请拆分工作簿后重试',
  LIMIT_ENTRY: 'Excel 内部单个文件解压后过大，请拆分工作簿后重试',
  LIMIT_EXPANDED: 'Excel 解压后的资料总量过大，请拆分工作簿后重试',
  LIMIT_SHEETS: 'Excel 工作表过多，请控制在 30 张以内',
  LIMIT_ROWS: 'Excel 单张工作表行数过多，请控制在 50000 行以内',
  LIMIT_COLUMNS: 'Excel 列数过多，请控制在 100 列以内',
  LIMIT_CELLS: 'Excel 单元格数量过多，请拆分工作簿后重试',
  LIMIT_CHARACTERS: 'Excel 文本总量过大，请拆分工作簿后重试',
  LIMIT_CELL: 'Excel 单个单元格文本过长，请缩短内容后重试',
  NO_SHEETS: 'Excel 中没有可导入的工作表',
  TIMEOUT: 'Excel 读取超时，已停止解析，请拆分工作簿后重试',
  CANCELED: 'Excel 导入已取消',
  BUSY: '正在读取 Excel，请稍候',
  CLOSED: 'Excel 导入已关闭',
  WORKER: 'Excel 解析已停止，文件可能过于复杂，请拆分工作簿后重试'
});

function createXlsxImporter({ timeoutMs = 15000, limits = {}, workerPath = path.join(__dirname, 'xlsx-worker.cjs') } = {}) {
  const effectiveLimits = { ...LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(LIMITS, key) || !Number.isSafeInteger(value) || value <= 0 || value > LIMITS[key]) throw new Error('Invalid XLSX resource limit');
    effectiveLimits[key] = value;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15000) throw new Error('Invalid XLSX timeout');
  let active = null, disposed = false;

  function parse(input, { signal } = {}) {
    if (disposed) return Promise.reject(new Error(ERRORS.CLOSED));
    if (active) return Promise.reject(new Error(ERRORS.BUSY));
    if (signal?.aborted) return Promise.reject(new Error(ERRORS.CANCELED));
    const source = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (!(source instanceof Uint8Array) || !source.byteLength) return Promise.reject(new Error(ERRORS.INVALID_XLSX));
    if (source.byteLength > effectiveLimits.fileBytes) return Promise.reject(new Error(ERRORS.LIMIT_FILE));
    // Transfer an owned copy. Never detach an IPC/caller buffer or a pooled Buffer.
    const bytes = Uint8Array.from(source);
    let worker;
    try {
      worker = new Worker(workerPath, {
        workerData: { bytes, limits: effectiveLimits }, transferList: [bytes.buffer],
        resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }
      });
    } catch { return Promise.reject(new Error(ERRORS.WORKER)); }

    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const job = { cancel: () => finish(new Error(ERRORS.CANCELED)) };
      active = job;
      async function finish(error, sheets) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        worker.removeListener('message', onMessage);
        worker.removeListener('error', onError);
        worker.removeListener('exit', onExit);
        worker.on('error', () => {});
        // Keep the single-worker slot occupied until termination has completed.
        await worker.terminate().catch(() => {});
        if (active === job) active = null;
        if (error) reject(error); else resolve(sheets);
      }
      function onMessage(message) {
        if (message?.ok === true && Array.isArray(message.sheets)) finish(null, message.sheets);
        else finish(new Error(ERRORS[message?.code] || ERRORS.INVALID_XLSX));
      }
      function onError() { finish(new Error(ERRORS.WORKER)); }
      function onExit() { finish(new Error(ERRORS.WORKER)); }
      function onAbort() { job.cancel(); }
      worker.once('message', onMessage);
      worker.once('error', onError);
      worker.once('exit', onExit);
      timer = setTimeout(() => finish(new Error(ERRORS.TIMEOUT)), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      // Also cover an abort occurring while the worker was being constructed.
      if (signal?.aborted) job.cancel();
    });
  }
  function cancel() { return active?.cancel(); }
  function dispose() { disposed = true; return cancel(); }
  return { parse, cancel, dispose };
}

module.exports = { createXlsxImporter, LIMITS, ERRORS };
