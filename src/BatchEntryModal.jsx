import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, X, Table2, Check, AlertCircle, LockKeyhole, Search, Settings2, RotateCcw } from 'lucide-react';
import { BROWSERS } from './model.mjs';
import { BATCH_COLUMNS, BATCH_ENTRY_COLUMNS, MAX_BATCH_ROWS, blankBatchRow, parseGridClipboard, applyGridPaste, validateBatchRows } from './batch-entry.mjs';
import ProfileHelp from './ProfileHelp';
import ExistingAccountsPanel from './ExistingAccountsPanel';
import './batch-entry.css';

const defaultWidths = () => Object.fromEntries(BATCH_ENTRY_COLUMNS.map(column => [column.key, column.width]));
const limitsFor = key => key === 'email' ? { min: 110, max: 360 } : { min: 64, max: 320 };
const clampWidth = (key, value) => {
  const { min, max } = limitsFor(key), fallback = BATCH_ENTRY_COLUMNS.find(column => column.key === key).width;
  return Math.round(Math.max(min, Math.min(max, Number.isFinite(Number(value)) && value !== '' ? Number(value) : fallback)));
};
const widthStrings = widths => Object.fromEntries(Object.entries(widths).map(([key, value]) => [key, String(value)]));

export default function BatchEntryModal({ onClose, onImport, existingEntries = [], groups = [] }) {
  const [rows, setRows] = useState(() => Array.from({ length: 8 }, blankBatchRow));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [attempted, setAttempted] = useState(false);
  const [widths, setWidths] = useState(defaultWidths), [widthInputs, setWidthInputs] = useState(() => widthStrings(defaultWidths()));
  const [widthSettings, setWidthSettings] = useState(false), [historyOpen, setHistoryOpen] = useState(false);
  const root = useRef(null), busyRef = useRef(false), closeRef = useRef(onClose), active = useRef(true), resize = useRef(null);
  const historyButton = useRef(null), historyOpenRef = useRef(false), widthSettingsRef = useRef(false), id = useId();
  closeRef.current = onClose; historyOpenRef.current = historyOpen; widthSettingsRef.current = widthSettings;
  const review = useMemo(() => validateBatchRows(rows, existingEntries), [rows, existingEntries]);
  const tableWidth = 70 + BATCH_ENTRY_COLUMNS.reduce((total, column) => total + widths[column.key], 0);
  const closeHistory = () => { setHistoryOpen(false); historyButton.current?.focus(); };

  useEffect(() => {
    active.current = true;
    const previous = document.activeElement, dialog = root.current;
    dialog.querySelector('[data-batch-cell="0:0"]')?.focus();
    const key = event => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (busyRef.current) return;
        if (widthSettingsRef.current) setWidthSettings(false);
        else if (historyOpenRef.current) { setHistoryOpen(false); historyButton.current?.focus(); }
        else closeRef.current();
      }
      if (event.key === 'Tab') {
        const controls = [...dialog.querySelectorAll('button,input,textarea,select,summary,[role="separator"]')]
          .filter(element => !element.disabled && element.tabIndex !== -1 && element.getClientRects().length);
        if (!controls.length) { event.preventDefault(); dialog.focus(); }
        else if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { active.current = false; resize.current = null; document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);

  const changeWidth = (key, value) => {
    const next = clampWidth(key, value);
    setWidths(previous => ({ ...previous, [key]: next }));
    setWidthInputs(previous => ({ ...previous, [key]: String(next) }));
  };
  const typeWidth = (key, value) => {
    setWidthInputs(previous => ({ ...previous, [key]: value }));
    const number = Number(value), { min, max } = limitsFor(key);
    if (value !== '' && Number.isFinite(number) && number >= min && number <= max) setWidths(previous => ({ ...previous, [key]: Math.round(number) }));
  };
  const startResize = (event, column) => {
    if (busyRef.current || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = { key: column.key, x: event.clientX, width: widths[column.key], pointerId: event.pointerId };
  };
  const moveResize = event => {
    const drag = resize.current;
    if (drag && drag.pointerId === event.pointerId) changeWidth(drag.key, drag.width + event.clientX - drag.x);
  };
  const endResize = event => {
    if (resize.current?.pointerId !== event.pointerId) return;
    resize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resizeKey = (event, column) => {
    if (busyRef.current || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    changeWidth(column.key, event.key === 'Home' ? column.width : widths[column.key] + (event.key === 'ArrowLeft' ? -8 : 8));
  };
  const update = (rowIndex, key, value) => {
    setRows(previous => previous.map((row, index) => index === rowIndex ? { ...row, [key]: value } : row));
    setMessage('');
  };
  const paste = (event, rowIndex, columnIndex) => {
    if (busyRef.current) { event.preventDefault(); return; }
    const content = event.clipboardData.getData('text/plain'), column = BATCH_ENTRY_COLUMNS[columnIndex];
    // Plain-text passwords retain tabs, newlines and edge spaces exactly.
    if (column.secret && !/<table(?:\s|>)/i.test(event.clipboardData.getData('text/html'))) {
      event.preventDefault(); if (!content) return;
      const current = rows[rowIndex][column.key], start = event.currentTarget.selectionStart ?? current.length, end = event.currentTarget.selectionEnd ?? start;
      update(rowIndex, column.key, current.slice(0, start) + content + current.slice(end)); return;
    }
    if (!/[\t\r\n]/.test(content)) return;
    event.preventDefault();
    try { setRows(applyGridPaste(rows, rowIndex, columnIndex, parseGridClipboard(content), BATCH_ENTRY_COLUMNS)); setMessage(''); }
    catch (error) { setMessage(error.message); }
  };
  const focusError = error => {
    const column = Math.max(0, BATCH_ENTRY_COLUMNS.findIndex(item => item.key === error.key));
    root.current?.querySelector(`[data-batch-cell="${error.row}:${column}"]`)?.focus();
  };
  const save = async () => {
    if (busyRef.current) return;
    setAttempted(true); setMessage('');
    const result = validateBatchRows(rows, existingEntries);
    if (result.errors.length) { focusError(result.errors[0]); return; }
    if (!result.added.length) { setMessage(result.filled ? '填写的邮箱、浏览器和 Profile 组合均已存在，没有需要新增的记录' : '请至少填写一行邮箱资料'); return; }
    busyRef.current = true; setBusy(true);
    try {
      await onImport(result.added);
      if (active.current) closeRef.current();
    } catch (error) { if (active.current) setMessage(error.message || '保存失败，请重试'); }
    finally { busyRef.current = false; if (active.current) setBusy(false); }
  };
  const errors = attempted ? review.errors : [];
  const width = historyOpen ? Math.min(1460, Math.max(1100, tableWidth + 410)) : Math.min(1100, Math.max(740, tableWidth + 2));

  return <div className="modal-shade batch-entry-shade">
    <section ref={root} className={`modal batch-entry-modal ${historyOpen ? 'has-history' : ''}`} style={{ width }} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} tabIndex={-1}>
      <header className="modal-head batch-entry-head"><div><h2 id={`${id}-title`}><Table2 size={22}/>批量录入账号</h2><p id={`${id}-hint`}>填写常用资料即可，其他设置保存后再编辑。按 Tab 切换下一格。</p></div><button type="button" className="icon-button" aria-label="关闭批量录入" disabled={busy} onClick={() => { if (!busyRef.current) onClose(); }}><X size={20}/></button></header>
      <ProfileHelp disabled={busy} className="batch-entry-profile-help"/>
      <div className="batch-entry-tools"><div className="batch-entry-counts"><span>已填写 <strong>{review.filled}</strong> 行</span><span>可新增 <strong>{review.added.length}</strong> 个</span><span>重复跳过 <strong>{review.skipped}</strong> 个</span><span>待完善 <strong>{review.incomplete}</strong> 个</span></div>
        <div className="batch-entry-actions"><button type="button" ref={historyButton} className={`button ${historyOpen ? 'is-active' : ''}`} disabled={busy} aria-expanded={historyOpen} aria-controls={`${id}-history`} onClick={() => setHistoryOpen(value => !value)}><Search size={15}/>查看已有账号</button><button type="button" className="button" disabled={busy} aria-expanded={widthSettings} aria-controls={`${id}-widths`} onClick={() => setWidthSettings(value => !value)}><Settings2 size={15}/>列宽设置</button><button type="button" className="button" disabled={busy || rows.length >= MAX_BATCH_ROWS} onClick={() => setRows(previous => [...previous, ...Array.from({ length: Math.min(5, MAX_BATCH_ROWS - previous.length) }, blankBatchRow)])}><Plus size={15}/>增加 5 行</button></div>
      </div>
      {widthSettings && <div className="batch-width-settings" id={`${id}-widths`} role="group" aria-label="录入列宽设置"><div className="batch-width-inputs">{BATCH_ENTRY_COLUMNS.map(column => <label key={column.key}><span>{column.label}</span><div><input type="number" aria-label={`${column.label}列宽`} min={limitsFor(column.key).min} max={limitsFor(column.key).max} value={widthInputs[column.key]} disabled={busy} onChange={event => typeWidth(column.key, event.target.value)} onBlur={event => changeWidth(column.key, event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); changeWidth(column.key, event.currentTarget.value); } }}/><small>px</small></div></label>)}</div><button type="button" className="text-button" disabled={busy} onClick={() => { const next = defaultWidths(); setWidths(next); setWidthInputs(widthStrings(next)); }}><RotateCcw size={13}/>恢复默认</button><p>也可拖动表头右侧边线调整宽度；聚焦边线后按左右方向键调整，Home 恢复该列默认宽度。</p></div>}
      <div className={`batch-entry-content ${historyOpen ? 'is-history-open' : ''}`}><div className="batch-entry-workspace"><div className="batch-entry-scroll"><table className="batch-entry-table" style={{ width: tableWidth }} aria-label="批量账号录入表格">
        <colgroup><col style={{ width: 34 }}/>{BATCH_ENTRY_COLUMNS.map(column => <col key={column.key} style={{ width: widths[column.key] }}/>) }<col style={{ width: 36 }}/></colgroup>
        <thead><tr><th className="batch-row-number" scope="col">行</th>{BATCH_ENTRY_COLUMNS.map(column => <th key={column.key} scope="col" data-batch-column={column.key}><span className="batch-column-label">{column.label}{column.required && <span className="batch-required">*</span>}{column.secret && <LockKeyhole size={12}/>}</span><span className="batch-column-resizer" role="separator" aria-orientation="vertical" aria-label={`调整${column.label}列宽`} aria-valuemin={limitsFor(column.key).min} aria-valuemax={limitsFor(column.key).max} aria-valuenow={widths[column.key]} aria-valuetext={`${widths[column.key]} 像素`} tabIndex={busy ? -1 : 0} onPointerDown={event => startResize(event, column)} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={() => { resize.current = null; }} onKeyDown={event => resizeKey(event, column)} title="拖动调整列宽"/></th>)}<th scope="col" aria-label="删除行"/></tr></thead>
        <tbody>{rows.map((row, rowIndex) => <tr key={row._key}><th className="batch-row-number" scope="row">{rowIndex + 1}</th>{BATCH_ENTRY_COLUMNS.map((column, columnIndex) => {
          const error = errors.find(item => item.row === rowIndex && item.key === column.key);
          const props = { 'aria-label': `第 ${rowIndex + 1} 行 ${column.label}`, 'data-batch-cell': `${rowIndex}:${columnIndex}`, 'aria-invalid': error ? true : undefined, title: error?.message, value: row[column.key], disabled: busy, autoComplete: 'off', spellCheck: false, onChange: event => update(rowIndex, column.key, event.target.value), onPaste: event => paste(event, rowIndex, columnIndex) };
          return <td key={column.key} className={error ? 'has-error' : ''}>{column.key === 'notes' ? <textarea {...props} rows={1}/> : <input {...props} type={column.secret ? 'password' : 'text'} list={column.key === 'browser' ? `${id}-browsers` : column.key === 'group' ? `${id}-groups` : undefined} placeholder={column.key === 'browser' ? '选择' : undefined}/>}</td>;
        })}<td className="batch-delete-cell"><button type="button" className="icon-button danger" aria-label={`删除第 ${rowIndex + 1} 行`} disabled={busy} onClick={() => { setRows(previous => previous.length === 1 ? [blankBatchRow()] : previous.filter((_, index) => index !== rowIndex)); setMessage(''); }}><Trash2 size={15}/></button></td></tr>)}</tbody>
      </table></div></div>{historyOpen && <aside className="batch-entry-history" id={`${id}-history`}><ExistingAccountsPanel entries={existingEntries} onClose={closeHistory}/></aside>}</div>
      <datalist id={`${id}-browsers`}>{BROWSERS.map(browser => <option value={browser} key={browser}/>)}</datalist><datalist id={`${id}-groups`}>{groups.map(group => <option value={typeof group === 'string' ? group : group.name} key={typeof group === 'string' ? group : group.name}/>)}</datalist>
      <div className="batch-entry-notice"><p>编号自动生成；标签、冷却和启动网页可在保存后单独编辑。查看已有账号时，当前录入草稿始终保留。</p><p><LockKeyhole size={12}/>密码和 TOTP 密钥遮盖并加密保存，每次最多 {MAX_BATCH_ROWS} 行。</p></div>
      {(message || errors.length > 0) && <div className="batch-entry-errors" role="alert"><AlertCircle size={16}/><div>{message && <p>{message}</p>}{errors.slice(0, 5).map((error, index) => <button type="button" key={`${error.row}:${error.key}:${index}`} onClick={() => focusError(error)}>第 {error.row + 1} 行 · {BATCH_COLUMNS.find(column => column.key === error.key)?.label}：{error.message}</button>)}{errors.length > 5 && <p>还有 {errors.length - 5} 项需要修改。</p>}</div></div>}
      <footer className="batch-entry-footer"><span>相同邮箱、浏览器和 Profile 的重复记录会跳过。</span><button type="button" className="button" disabled={busy} onClick={() => { if (!busyRef.current) onClose(); }}>取消</button><button type="button" className="button primary" disabled={busy} onClick={save}><Check size={16}/>{busy ? '保存中…' : `保存 ${review.added.length} 个账号`}</button></footer>
    </section>
  </div>;
}
