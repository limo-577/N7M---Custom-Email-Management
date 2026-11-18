import React, { useEffect, useId, useRef, useState } from 'react';
import { LockKeyhole, Download, Upload, X, ShieldCheck } from 'lucide-react';
import './backup-modal.css';

export default function BackupModal({ count, onClose, onExport, onPreviewRestore, onRestore, onRevoke }) {
  const [tab, setTab] = useState('export'), [format, setFormat] = useState('encrypted');
  const [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [samePassword, setSamePassword] = useState(true), [currentPassword, setCurrentPassword] = useState('');
  const [file, setFile] = useState(null), [preview, setPreview] = useState(null), [policy, setPolicy] = useState('fill'), [settings, setSettings] = useState(false);
  const root = useRef(), input = useRef(), active = useRef(true), working = useRef(false), currentPreview = useRef(null), id = useId();
  const revoke = token => { if (token) Promise.resolve(onRevoke?.(token)).catch(() => {}); };
  const close = () => { if (!working.current) onClose(); };
  useEffect(() => {
    active.current = true;
    const previous = document.activeElement; root.current?.querySelector('button')?.focus();
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); if (!working.current) onClose(); }
      if (event.key === 'Tab') {
        const controls = [...root.current.querySelectorAll('button,input,select')].filter(element => !element.disabled && element.getClientRects().length);
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { active.current = false; document.removeEventListener('keydown', key); revoke(currentPreview.current?.token); previous?.focus(); };
  }, []);
  const changeTab = value => { if (working.current) return; revoke(currentPreview.current?.token); currentPreview.current = null; setPreview(null); setPassword(''); setCurrentPassword(''); setError(''); setTab(value); };
  const run = async action => {
    working.current = true; setBusy(true); setError('');
    try { await action(); } catch (failure) { if (active.current) setError(failure.message || '操作失败，请重试'); }
    finally { working.current = false; if (active.current) setBusy(false); }
  };
  const exportFile = event => {
    event.preventDefault(); const master = password; setPassword('');
    run(async () => { const result = await onExport({ format, password: master }); if (active.current && !result?.canceled) onClose(); });
  };
  const readBackup = event => {
    event.preventDefault(); const master = password, currentMaster = samePassword ? password : currentPassword; setPassword(''); setCurrentPassword('');
    run(async () => {
      if (!file) throw new Error('请先选择加密备份文件');
      if (file.size > 64 * 1024 * 1024) throw new Error('备份文件过大，最大 64 MB');
      const buffer = new Uint8Array(await file.arrayBuffer());
      const result = await onPreviewRestore({ buffer, password: master, currentPassword: currentMaster });
      if (!active.current) { revoke(result.token); return; }
      currentPreview.current = result; setPreview(result);
      setSettings(result.currentCount === 0);
    });
  };
  return <div className="modal-shade" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><section ref={root} className="modal backup-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
    <header className="modal-head"><div><h2 id={`${id}-title`}>{tab === 'export' ? '导出资料' : '恢复加密备份'}</h2><p>密码与 TOTP 随加密备份一起保存和恢复。</p></div><button className="icon-button" onClick={close} disabled={busy} aria-label="关闭备份窗口"><X size={20}/></button></header>
    <div className="backup-tabs"><button type="button" className={tab === 'export' ? 'active' : ''} onClick={() => changeTab('export')} disabled={busy}><Download size={16}/>导出备份</button><button type="button" className={tab === 'restore' ? 'active' : ''} onClick={() => changeTab('restore')} disabled={busy}><Upload size={16}/>恢复备份</button></div>
    {tab === 'export' ? <form onSubmit={exportFile}>
      <label className="backup-option"><input type="radio" name={`${id}-format`} value="encrypted" checked={format === 'encrypted'} onChange={() => { setFormat('encrypted'); setError(''); }} disabled={busy}/><span><strong>加密完整备份 · 推荐</strong><small>导出 {count} 个账号，包含密码、TOTP、分组和备注；使用当前软件密码加密。</small></span><ShieldCheck size={20}/></label>
      <label className="backup-option"><input type="radio" name={`${id}-format`} value="csv" checked={format === 'csv'} onChange={() => { setFormat('csv'); setPassword(''); setError(''); }} disabled={busy}/><span><strong>普通 CSV</strong><small>用于表格查看和整理，不包含密码和 TOTP 密钥。</small></span></label>
      {format === 'encrypted' && <><label className="backup-field">确认软件密码<input aria-label="导出软件密码" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy}/></label><p className="backup-help"><LockKeyhole size={14}/>这是当前软件密码，无需另外设置备份密码。以后恢复此文件时，使用导出当时的软件密码。</p></>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <footer className="modal-footer"><button type="button" className="button" onClick={close} disabled={busy}>取消</button><button className="button primary" disabled={busy || !count}><Download size={16}/>{busy ? '正在处理…' : format === 'encrypted' ? '导出加密备份' : '导出 CSV'}</button></footer>
    </form> : <>
      {!preview ? <form onSubmit={readBackup}><div className="backup-file"><button type="button" className="button" onClick={() => input.current.click()} disabled={busy}><Upload size={16}/>选择加密备份</button><span>{file?.name || '.n7mbackup 文件'}</span><input ref={input} hidden type="file" accept=".n7mbackup" onChange={event => { setFile(event.target.files?.[0] || null); setError(''); }} disabled={busy}/></div><label className="backup-field">备份密码<input aria-label="备份密码" type="password" autoComplete="off" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy}/></label><label className="backup-settings"><input type="checkbox" aria-label="备份密码与当前软件密码相同" checked={samePassword} onChange={event => { setSamePassword(event.target.checked); setCurrentPassword(''); }} disabled={busy}/>备份密码与当前软件密码相同</label>{!samePassword && <label className="backup-field">当前软件密码<input aria-label="恢复当前软件密码" type="password" autoComplete="current-password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} disabled={busy}/></label>}<p className="backup-help">填写导出该文件时的软件密码。修改过软件密码或在其他电脑恢复时，取消上方勾选并验证当前软件密码。</p>{error && <p className="error-text" role="alert">{error}</p>}<footer className="modal-footer"><button type="button" className="button" onClick={close} disabled={busy}>取消</button><button className="button primary" disabled={busy || !file}>{busy ? '正在解密检查…' : '检查备份'}</button></footer></form> : <>
        <div className="backup-review"><strong>备份含 {preview.total} 个账号</strong><span>{preview.newCount} 个新增 · {preview.existingCount} 个账号组合已存在</span><small>密码与 TOTP 已通过解密校验，此处不显示凭据。</small></div>
        <label className="backup-field">相同账号组合如何处理<select aria-label="备份恢复方式" value={policy} onChange={event => setPolicy(event.target.value)} disabled={busy}><option value="fill">只补齐空白资料，保留已填写内容</option><option value="overwrite">用备份覆盖相同组合的资料</option><option value="add">仅新增账号，跳过已有组合</option></select></label>
        <label className="backup-settings"><input type="checkbox" checked={settings} onChange={event => setSettings(event.target.checked)} disabled={busy}/>同时恢复默认冷却设置</label><p className="backup-help">按邮箱、浏览器和 Profile 的组合匹配账号，同邮箱的不同浏览器或 Profile 会独立新增。分组会合并保留；浏览器打开状态不会恢复到当前电脑。覆盖方式会替换匹配账号的密码和 TOTP。</p>
        {error && <p className="error-text" role="alert">{error}</p>}<footer className="modal-footer"><button type="button" className="button" disabled={busy} onClick={() => changeTab('restore')}>重新选择</button><button type="button" className="button primary" disabled={busy} onClick={() => run(async () => { await onRestore({ token: preview.token, policy, restoreSettings: settings }); if (active.current) onClose(); })}>{busy ? '正在恢复…' : '确认恢复资料'}</button></footer>
      </>}
    </>}
  </section></div>;
}
