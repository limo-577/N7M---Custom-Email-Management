import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, LockKeyhole, RotateCcw, Table2, X } from 'lucide-react';
import { BROWSERS, browserNameOf, text } from './model.mjs';
import { BULK_EDIT_COLUMNS, MAX_BULK_EDIT_ROWS, applyBulkPaste, generateBulkPatches, makeBulkDrafts, parseGridClipboard } from './bulk-edit.mjs';
import ProfileHelp from './ProfileHelp';
import './bulk-edit.css';

export default function BulkEditModal({ entries = [], allEntries = entries, groups = [], onClose, onAuthorize, onSave, onRevoke }) {
  const scope = useRef(entries.map(entry => entry.id)), root = useRef(null), active = useRef(true), requestVersion = useRef(0);
  const busyRef = useRef(false), tokenRef = useRef(''), closeRef = useRef(onClose), revokeRef = useRef(onRevoke), id = useId();
  closeRef.current = onClose; revokeRef.current = onRevoke;
  const [password, setPassword] = useState(''), [session, setSession] = useState(null), [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [attempted, setAttempted] = useState(false), [remaining, setRemaining] = useState(0);
  const validScope = scope.current.length > 0 && scope.current.length <= MAX_BULK_EDIT_ROWS;
  const revokeToken = token => {
    if (token && revokeRef.current) { try { Promise.resolve(revokeRef.current(token)).catch(() => {}); } catch { /* Closing remains available if IPC has already gone away. */ } }
  };
  const revoke = () => {
    const token = tokenRef.current; tokenRef.current = '';
    revokeToken(token);
  };
  const relock = (notice = '') => {
    requestVersion.current++; revoke(); setSession(null); setRows([]); setPassword(''); setAttempted(false); setMessage(notice);
    busyRef.current = false; setBusy(false);
  };
  const close = () => { if (!busyRef.current) { relock(); closeRef.current(); } };
  const closeAction = useRef(close); closeAction.current = close;
  useEffect(() => {
    active.current = true;
    const previous = document.activeElement, dialog = root.current;
    dialog.querySelector('input')?.focus();
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); closeAction.current(); }
      if (event.key === 'Tab') {
        const controls = [...dialog.querySelectorAll('button,input,textarea,summary')].filter(element => !element.disabled && element.getClientRects().length);
        if (!controls.length) { event.preventDefault(); dialog.focus(); }
        else if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { active.current = false; requestVersion.current++; revoke(); document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  useEffect(() => {
    if (!session) { root.current?.querySelector('[data-bulk-edit-password]')?.focus(); return; }
    root.current?.querySelector('[data-bulk-edit-cell="0:0"]')?.focus();
    const update = () => {
      const milliseconds = session.expiresAt - Date.now(); setRemaining(Math.max(0, Math.ceil(milliseconds / 1000)));
      if (milliseconds <= 0) relock('编辑会话已到期，请重新验证软件密码。');
    };
    update(); const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [session]);

  const authorize = async event => {
    event.preventDefault(); if (!validScope || busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage('');
    const version = requestVersion.current;
    let issuedToken = '';
    try {
      const result = await onAuthorize(password, [...scope.current]);
      issuedToken = typeof result?.token === 'string' ? result.token : '';
      if (!active.current || version !== requestVersion.current) { revokeToken(issuedToken); return; }
      if (!result || !Array.isArray(result.entries) || typeof result.token !== 'string' || !result.token ||
        result.entries.length !== scope.current.length || result.entries.some(entry => !entry || typeof entry.id !== 'string') || new Set(result.entries.map(entry => entry.id)).size !== scope.current.length ||
        result.entries.some(entry => !scope.current.includes(entry.id))) throw new Error('编辑会话资料无效，请重新验证软件密码');
      const ordered = scope.current.map(accountId => result.entries.find(entry => entry.id === accountId));
      const expiration = result.expiresAt == null ? Date.now() + 5 * 60 * 1000 : Number(result.expiresAt);
      if (!Number.isFinite(expiration) || expiration <= Date.now()) throw new Error('编辑会话已到期，请重新验证软件密码');
      const expiresAt = Math.min(expiration, Date.now() + 5 * 60 * 1000);
      tokenRef.current = result.token; setPassword(''); setRows(makeBulkDrafts(ordered));
      setSession({ entries: ordered, token: result.token, revision: result.revision, expiresAt }); setAttempted(false);
    } catch (error) { revokeToken(issuedToken); if (active.current && version === requestVersion.current) setMessage(error.message || '验证失败，请重试'); }
    finally { if (active.current && version === requestVersion.current) { busyRef.current = false; setBusy(false); } }
  };
  const baseline = useMemo(() => session ? makeBulkDrafts(session.entries) : [], [session]);
  const review = useMemo(() => session ? generateBulkPatches(session.entries, rows, allEntries) : { patches: [], errors: [], changedRows: 0, changedFields: 0 }, [session, rows, allEntries]);
  const dirtyRows = rows.filter((row, index) => BULK_EDIT_COLUMNS.some(({ key }) => row[key] !== baseline[index]?.[key])).length;
  const live = new Map(allEntries.map(entry => [entry.id, entry]));
  const routingLocked = rowIndex => !!(live.get(rows[rowIndex]?.id) || session?.entries[rowIndex])?.browserWindow;
  const blocked = (rowIndex, key, value) => routingLocked(rowIndex) && ['browser', 'profile'].includes(key) &&
    (key === 'browser' ? browserNameOf(value) !== browserNameOf(rows[rowIndex][key]) : text(value) !== text(rows[rowIndex][key]));
  const update = (rowIndex, key, value) => { setRows(previous => previous.map((row, index) => index === rowIndex ? { ...row, [key]: value } : row)); setMessage(''); };
  const paste = (event, rowIndex, columnIndex) => {
    const content = event.clipboardData.getData('text/plain'), column = BULK_EDIT_COLUMNS[columnIndex];
    if (busyRef.current) { event.preventDefault(); return; }
    if (column.secret && !/<table(?:\s|>)/i.test(event.clipboardData.getData('text/html'))) {
      event.preventDefault(); if (!content) return;
      const current = rows[rowIndex][column.key], start = event.currentTarget.selectionStart ?? current.length, end = event.currentTarget.selectionEnd ?? start;
      update(rowIndex, column.key, current.slice(0, start) + content + current.slice(end)); return;
    }
    if (!/[\t\r\n]/.test(content)) return;
    event.preventDefault();
    try { setRows(applyBulkPaste(rows, rowIndex, columnIndex, parseGridClipboard(content), blocked)); setMessage(''); }
    catch (error) { setMessage(error.message); }
  };
  const focusError = error => {
    const column = BULK_EDIT_COLUMNS.findIndex(item => item.key === error.key);
    root.current?.querySelector(`[data-bulk-edit-cell="${error.row}:${column}"]`)?.focus();
  };
  const save = async () => {
    if (!session || busyRef.current) return;
    setAttempted(true); setMessage('');
    if (Date.now() >= session.expiresAt) { relock('编辑会话已到期，请重新验证软件密码。'); return; }
    const result = generateBulkPatches(session.entries, rows, allEntries);
    if (result.errors.length) { focusError(result.errors[0]); return; }
    if (!result.patches.length) { setMessage('修改内容与原资料一致，没有需要保存的变更'); return; }
    busyRef.current = true; setBusy(true); const version = requestVersion.current;
    try {
      await onSave({ token: session.token, revision: session.revision, patches: result.patches });
      if (active.current && version === requestVersion.current) { relock(); closeRef.current(); }
    } catch (error) { if (active.current && version === requestVersion.current) setMessage(error.message || '保存失败，请重试'); }
    finally { if (active.current && version === requestVersion.current) { busyRef.current = false; setBusy(false); } }
  };
  return <div className="modal-shade bulk-edit-shade" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={root} className={`modal bulk-edit-modal ${session ? 'is-authorized' : 'is-locked'}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
      <header className="modal-head bulk-edit-head"><div><h2 id={`${id}-title`}>{session ? <Table2 size={23}/> : <LockKeyhole size={23}/>}批量修改账号资料</h2><p>{session ? '逐行修改不同账号，按 Tab 连续填写；密码和 TOTP 密钥始终遮盖。' : '再次验证软件密码后，才能批量读取和修改账号密码、TOTP 等资料。'}</p></div><button className="icon-button" onClick={close} disabled={busy} aria-label="关闭批量修改"><X size={20}/></button></header>
      {!session ? <form className="bulk-edit-auth" onSubmit={authorize}>
        <p className="bulk-edit-scope">本次编辑 <strong>{scope.current.length}</strong> 个账号，验证会话最长 5 分钟。</p>
        {!validScope && <p className="error-text" role="alert">{scope.current.length ? `每次最多修改 ${MAX_BULK_EDIT_ROWS} 个账号，请先筛选或勾选需要修改的账号。` : '没有可编辑的账号，请先添加或选择账号。'}</p>}
        <label htmlFor={`${id}-password`}>软件密码</label><input id={`${id}-password`} data-bulk-edit-password aria-label="批量编辑软件密码" type="password" autoComplete="current-password" maxLength={1024} required value={password} onChange={event => { setPassword(event.target.value); setMessage(''); }} disabled={busy || !validScope}/>
        {message && <p className="error-text" role="alert">{message}</p>}
        <p className="bulk-edit-private"><LockKeyhole size={14}/>验证前不会加载账号密码与 TOTP 密钥；锁定或关闭此界面后清除编辑内容。</p>
        <footer className="bulk-edit-auth-actions"><button className="button" type="button" onClick={close} disabled={busy}>取消</button><button className="button primary" disabled={busy || !validScope || !password}>{busy ? '正在验证…' : '验证密码并编辑'}</button></footer>
      </form> : <>
        <div className="bulk-edit-tools"><div><span>共 <strong>{rows.length}</strong> 个账号</span><span>已修改 <strong>{dirtyRows}</strong> 行</span><span className="bulk-edit-session"><LockKeyhole size={13}/>剩余 {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span></div><div><button className="button" onClick={() => { setRows(makeBulkDrafts(session.entries)); setAttempted(false); setMessage(''); }} disabled={busy || !dirtyRows}><RotateCcw size={15}/>撤销本次修改</button><button className="button" onClick={() => relock()} disabled={busy}><LockKeyhole size={15}/>重新锁定</button></div></div>
        <ProfileHelp disabled={busy} className="bulk-edit-profile-help"/>
        <div className="bulk-edit-scroll"><table className="bulk-edit-table" aria-label="批量修改账号表格"><thead><tr><th className="bulk-edit-row-number">行</th>{BULK_EDIT_COLUMNS.map(column => <th key={column.key} style={{ width: column.width }}>{column.label}{column.required && <span className="bulk-edit-required"> *</span>}{column.secret && <LockKeyhole size={12}/>}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={row.id}><th scope="row">{rowIndex + 1}</th>{BULK_EDIT_COLUMNS.map((column, columnIndex) => {
          const error = attempted ? review.errors.find(item => item.row === rowIndex && item.key === column.key) : null;
          const readOnly = ['browser', 'profile'].includes(column.key) && routingLocked(rowIndex), changed = row[column.key] !== baseline[rowIndex]?.[column.key];
          const attributes = { value: row[column.key], disabled: busy, readOnly, onChange: event => update(rowIndex, column.key, event.target.value), onPaste: event => paste(event, rowIndex, columnIndex),
            'data-bulk-edit-cell': `${rowIndex}:${columnIndex}`, 'aria-label': `第 ${rowIndex + 1} 行 ${column.label}`, 'aria-invalid': error ? true : undefined, 'aria-readonly': readOnly ? true : undefined,
            title: error?.message || (readOnly ? '对应浏览器已打开，关闭窗口后可修改类型和 Profile' : undefined), autoComplete: 'off', spellCheck: false };
          return <td key={column.key} className={`${error ? 'has-error' : ''} ${changed ? 'is-changed' : ''} ${readOnly ? 'is-readonly' : ''}`}>{column.key === 'notes' ? <textarea {...attributes} rows={1}/> : <input {...attributes} type={column.secret ? 'password' : 'text'} inputMode={column.key === 'cooldownHours' ? 'decimal' : undefined} list={column.key === 'browser' ? `${id}-browsers` : column.key === 'group' ? `${id}-groups` : undefined} placeholder={column.key === 'displayId' ? '留空自动编号' : column.key === 'cooldownHours' ? '默认' : undefined} data-lpignore="true" data-1p-ignore="true"/>}</td>;
        })}</tr>)}</tbody></table></div>
        <datalist id={`${id}-browsers`}>{BROWSERS.map(browser => <option key={browser} value={browser}/>)}</datalist><datalist id={`${id}-groups`}>{groups.map(group => <option key={group} value={group}/>)}</datalist>
        <p className="bulk-edit-notice">只保存已修改的字段，一次统一检查并保存。清空密码或 TOTP 单元格会移除该凭据。浏览器已打开时，其类型和 Profile 暂时只读。</p>
        {(message || (attempted && review.errors.length > 0)) && <div className="bulk-edit-errors" role="alert"><AlertCircle size={17}/><div>{message && <p>{message}</p>}{attempted && review.errors.slice(0, 5).map((error, index) => <button key={index} onClick={() => focusError(error)}>第 {error.row + 1} 行 · {BULK_EDIT_COLUMNS.find(column => column.key === error.key)?.label}：{error.message}</button>)}{attempted && review.errors.length > 5 && <p>另有 {review.errors.length - 5} 项需要修正。</p>}</div></div>}
        <footer className="bulk-edit-footer"><span><LockKeyhole size={14}/>会话到期自动锁定；保存后的资料继续加密存储。</span><button className="button" onClick={close} disabled={busy}>取消</button><button className="button primary" onClick={save} disabled={busy || !dirtyRows}><Check size={17}/>{busy ? '正在加密保存…' : `保存 ${review.changedRows} 个账号的修改`}</button></footer>
      </>}
    </section>
  </div>;
}
