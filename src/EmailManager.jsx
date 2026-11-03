import React, { useEffect, useRef, useState } from 'react';
import { Mail, Plus, Search, Upload, Download, Settings2, PanelTop, Pencil, Trash2, StickyNote, X, Check, Copy, Play, RotateCcw, Clock3, AlertCircle, Folder, Pin, PinOff, Maximize2, FileSpreadsheet, CheckCircle2, LockKeyhole, KeyRound, Globe, ChevronDown, ArrowDownUp, ArrowDown, ArrowUp, FolderInput } from 'lucide-react';
import { APP_NAME, BROWSERS, normalizeState, normalizeEntry, issuesOf, effectiveStatus, hoursOf, webUrl, elapsed, dateTime, parseDelimited, rowsToEntries, mergeImport, tagsOf } from './model.mjs';
import AuthGate from './AuthGate';
const EMPTY = { email: '', browser: '', profile: '', displayId: '', launchUrl: '', notes: '', group: '', tags: '', cooldownHours: '', password: '', totpSecret: '' };
const PROFILE_PAGES = [
  { browser: 'Chrome', url: 'chrome://version' },
  { browser: 'Edge', url: 'edge://version' },
  { browser: 'Brave', url: 'brave://version' },
];
function Modal({ title, subtitle, children, onClose, wide = false }) {
  const ref = useRef(null), closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement, root = ref.current;
    root.querySelector('input:not([type=checkbox]),textarea,select,button')?.focus();
    const key = e => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const list = [...root.querySelectorAll('button,input,select,textarea')].filter(el => !el.disabled && el.getClientRects().length);
        if (e.shiftKey && document.activeElement === list[0]) { e.preventDefault(); list.at(-1)?.focus(); }
        else if (!e.shiftKey && document.activeElement === list.at(-1)) { e.preventDefault(); list[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="modal-shade" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section ref={ref} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><header className="modal-head"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="关闭弹窗"><X size={20}/></button></header>{children}</section></div>;
}
function Checkbox({ indeterminate, ...props }) {
  const ref = useRef(); useEffect(() => { ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" {...props}/>;
}
export default function EmailManager() {
  const isToolbar = new URLSearchParams(window.location.search).get('toolbar') === '1';
  const [data, setData] = useState(normalizeState([])), current = useRef(data);
  const [auth, setAuth] = useState(null), authRef = useRef(null), generation = useRef(0);
  const [loadError, setLoadError] = useState(''), [toast, setToast] = useState(null), [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(''), [group, setGroup] = useState(''), [tag, setTag] = useState('');
  const [sort, setSort] = useState('original'), [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [newGroup, setNewGroup] = useState(''), [groupError, setGroupError] = useState('');
  const groupMenuRef = useRef(null), groupTriggerRef = useRef(null);
  const [selected, setSelected] = useState(new Set()), [modal, setModal] = useState(null), [form, setForm] = useState(EMPTY), [formError, setFormError] = useState('');
  const [enabled, setEnabled] = useState(new Set()), [paste, setPaste] = useState(''), [preview, setPreview] = useState(null), [importError, setImportError] = useState(''), [fileBusy, setFileBusy] = useState(false);
  const [pinned, setPinned] = useState(true), [, tick] = useState(0);
  const toastTimer = useRef(), fileRef = useRef(), importRequest = useRef(null), importCancellation = useRef(Promise.resolve());
  const cancelImport = () => {
    const request = importRequest.current; importRequest.current = null;
    setFileBusy(false);
    if (request) {
      const cancellation = window.emailManager.cancelExcelImport(request.id).catch(() => {});
      importCancellation.current = Promise.all([importCancellation.current, cancellation]).then(() => {});
    }
    return importCancellation.current;
  };
  const notify = (message, error = false) => { if (authRef.current?.locked) return; setToast({ message, error }); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), error ? 10000 : 4000); };
  const setAuthStatus = value => { authRef.current = value; setAuth(value); };
  const accept = value => { if (authRef.current?.locked) return; const next = normalizeState(value); if (next.revision >= current.current.revision) { current.current = next; setData(next); } };
  const purge = () => {
    cancelImport();
    generation.current++; clearTimeout(toastTimer.current);
    const empty = normalizeState([]); current.current = empty; setData(empty); setSelected(new Set()); setModal(null); setForm(EMPTY); setFormError(''); setPreview(null); setPaste(''); setSearch(''); setGroup(''); setTag(''); setSort('original'); setGroupMenuOpen(false); setNewGroup(''); setGroupError(''); setImportError(''); setToast(null); setBusy(false); setFileBusy(false);
    setAuthStatus({ configured: authRef.current?.configured ?? true, locked: true });
  };
  useEffect(() => {
    let active = true;
    const bridge = window.emailManager;
    if (!bridge?.getVaultStatus) { setLoadError('请使用 Windows 桌面版，以启用加密资料库。'); return; }
    const unlisten = bridge.onEmailDataUpdated(value => { if (active && authRef.current && !authRef.current.locked) accept(value); });
    const unlockListener = bridge.onVaultLocked(() => { if (active) purge(); });
    (async () => {
      try {
        const result = await bridge.getVaultStatus(); if (!result.ok) throw new Error(result.error);
        if (!active) return; setAuthStatus(result);
        if (!result.locked && result.configured) { const loaded = await bridge.loadEmailData(); if (!loaded.ok) throw new Error(loaded.error); if (active && !authRef.current.locked) accept(loaded.data); }
      } catch (e) { if (active) setLoadError(e.message); }
    })();
    const timer = setInterval(() => tick(v => v + 1), 15000);
    return () => { active = false; unlisten?.(); unlockListener?.(); clearInterval(timer); clearTimeout(toastTimer.current); };
  }, []);
  useEffect(() => { setSelected(previous => new Set([...previous].filter(id => data.entries.some(e => e.id === id)))); }, [data.entries]);
  useEffect(() => {
    if (group && group !== '__none' && !data.groups?.includes(group)) setGroup('');
  }, [data.groups, group]);
  useEffect(() => {
    if (!groupMenuOpen) return;
    groupMenuRef.current?.querySelector('[data-group-first]')?.focus();
    const outside = event => { if (!groupMenuRef.current?.contains(event.target)) setGroupMenuOpen(false); };
    const escape = event => {
      if (event.key === 'Escape') { setGroupMenuOpen(false); groupTriggerRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', escape); };
  }, [groupMenuOpen]);
  const unlock = async (password, setup) => {
    const version = generation.current;
    const result = await (setup ? window.emailManager.setupVault(password) : window.emailManager.unlockVault(password));
    if (!result.ok) throw new Error(result.error);
    if (version !== generation.current) throw new Error('锁定状态已变化，请重新解锁');
    setAuthStatus({ ...result, configured: true, locked: false, data: undefined });
    if (result.data) accept(result.data); else { const loaded = await window.emailManager.loadEmailData(); if (!loaded.ok) throw new Error(loaded.error); accept(loaded.data); }
  };
  const transact = async operation => {
    if (authRef.current?.locked) throw new Error('资料库已锁定');
    const version = generation.current;
    const result = await window.emailManager.mutateEmailData(operation); if (!result.ok) throw new Error(result.error);
    if (version === generation.current) accept(result.data);
  };
  const perform = async (action, message) => { setBusy(true); try { await action(); if (message) notify(message); return true; } catch (e) { notify(e.message, true); return false; } finally { setBusy(false); } };
  const closeModal = () => { if (!busy) { cancelImport(); setModal(null); setForm(EMPTY); setFormError(''); setPreview(null); setPaste(''); } };
  const openEditor = async (entry, mode = 'edit') => {
    const version = generation.current;
    let secrets = {};
    if (entry && mode === 'edit') {
      setBusy(true);
      try { const result = await window.emailManager.readEntrySecrets(entry.id); if (!result.ok) throw new Error(result.error); secrets = { password: result.password || '', totpSecret: result.totpSecret || '' }; }
      catch (e) { notify(e.message, true); return; } finally { setBusy(false); }
    }
    if (version !== generation.current || authRef.current.locked) return;
    setForm({ ...EMPTY, ...entry, ...secrets, tags: tagsOf(entry?.tags).join(', '), cooldownHours: entry?.cooldownHours ?? '' }); setEnabled(new Set()); setFormError(''); setModal({ type: mode, ids: entry ? [entry.id] : [] });
  };
  const openBulk = () => { setForm(EMPTY); setEnabled(new Set()); setFormError(''); setModal({ type: 'bulk', ids: [...selected] }); };
  const saveEditor = async e => {
    e.preventDefault(); setFormError('');
    try {
      const bulk = modal.type === 'bulk'; if (bulk && !enabled.size) throw new Error('请勾选至少一个需要修改的字段');
      const patch = modal.type === 'notes' ? { notes: form.notes } : bulk ? Object.fromEntries([...enabled].map(key => [key, form[key]])) : { ...form };
      delete patch.id; delete patch.hasPassword; delete patch.hasTotp;
      if ('email' in patch && !patch.email.trim()) throw new Error('请填写邮箱资料');
      if (patch.launchUrl) patch.launchUrl = webUrl(patch.launchUrl);
      if ('tags' in patch) patch.tags = tagsOf(patch.tags);
      if ('cooldownHours' in patch) { if (patch.cooldownHours === '') patch.cooldownHours = null; else if (!Number.isFinite(Number(patch.cooldownHours)) || Number(patch.cooldownHours) <= 0 || Number(patch.cooldownHours) > 8760) throw new Error('冷却小时须大于 0 且不超过 8760'); }
      if (modal.type === 'new' && current.current.entries.some(item => item.email.toLowerCase() === patch.email.trim().toLowerCase())) throw new Error('该邮箱已存在');
      setBusy(true); await transact(modal.type === 'new' ? { type: 'import', entries: [normalizeEntry(patch)] } : { type: 'update', ids: modal.ids, patch });
      setModal(null); setForm(EMPTY); notify('资料已加密保存');
    } catch (error) { if (!authRef.current.locked) setFormError(error.message); } finally { setBusy(false); }
  };
  const startEntry = async entry => { const version = generation.current; const result = await window.emailManager.openEntry(entry.id); if (!result.ok) throw new Error(result.error); if (version === generation.current) accept(result.data); };
  const start = entry => { if (issuesOf(entry).length) { notify(`请编辑账号：${issuesOf(entry).join('、')}`, true); return; } perform(() => startEntry(entry), entry.launchUrl ? '已打开启动网页，并开始冷却计时' : '已打开浏览器，并开始冷却计时'); };
  const startSelected = () => perform(async () => { let success = 0; const failed = []; const version = generation.current; for (const entry of current.current.entries.filter(e => selected.has(e.id))) { if (version !== generation.current) break; try { await startEntry(entry); success++; } catch (e) { failed.push(`${entry.displayId || entry.email}：${e.message}`); } } notify(`已启动 ${success} 个${failed.length ? `；${failed.length} 个未启动：${failed.slice(0, 3).join('；')}` : ''}`, !!failed.length); });
  const copy = entry => perform(async () => { const result = await window.emailManager.copyText(entry.email); if (!result.ok) throw new Error(result.error); }, '邮箱资料已复制');
  const copyProfilePage = page => perform(async () => { const result = await window.emailManager.copyText(page.url); if (!result.ok) throw new Error(result.error); }, `已复制 ${page.browser} 地址，在该浏览器地址栏粘贴打开后查看 Profile Path`);
  const copySecret = (entry, field) => perform(async () => { const result = await window.emailManager.copyCredential(entry.id, field); if (!result.ok) throw new Error(result.error); }, field === 'password' ? '密码已复制，30 秒后自动清理剪贴板' : '当前 TOTP 验证码已复制，30 秒后自动清理剪贴板');
  const exportData = ids => perform(async () => { const result = await window.emailManager.exportEmailData(ids); if (!result.ok) throw new Error(result.error); if (!result.canceled) notify('CSV 已导出（不包含密码和 TOTP 密钥）'); });
  const prepareRows = rows => { const incoming = rowsToEntries(rows); if (!incoming.length) throw new Error('没有识别到资料，请检查内容或所选工作表'); setPreview(mergeImport(current.current.entries, incoming)); setImportError(''); };
  const readFile = async event => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    const previousImport = cancelImport();
    const version = generation.current, request = { id: crypto.randomUUID() };
    importRequest.current = request;
    const active = () => importRequest.current === request && version === generation.current;
    setFileBusy(true); setPreview(null); setImportError('');
    setModal(previous => ({ ...previous, sheets: null }));
    try {
      await previousImport; if (!active()) return;
      if (file.size > 20 * 1024 * 1024) throw new Error('文件请控制在 20 MB 以内');
      if (/\.xlsx$/i.test(file.name)) {
        const buffer = await file.arrayBuffer(); if (!active()) return;
        const result = await window.emailManager.importExcelFile(request.id, new Uint8Array(buffer));
        if (!active()) return;
        if (!result.ok) throw new Error(result.error);
        const sheets = result.sheets;
        setModal(previous => ({ ...previous, sheets: sheets.length > 1 ? sheets : null, sheetIndex: 0 })); prepareRows(sheets[0].rows);
      } else if (/\.(csv|tsv)$/i.test(file.name)) {
        const bytes = await file.arrayBuffer(); if (!active()) return;
        let content = new TextDecoder('utf-8').decode(bytes); if (content.includes('\ufffd')) content = new TextDecoder('gb18030').decode(bytes);
        setModal(previous => ({ ...previous, sheets: null })); prepareRows(parseDelimited(content, /\.tsv$/i.test(file.name) ? '\t' : undefined));
      } else throw new Error('支持 .xlsx、.csv、.tsv；旧版 .xls 请另存为 .xlsx');
    } catch (e) { if (active()) setImportError(e.message); }
    finally { if (active()) { importRequest.current = null; setFileBusy(false); } }
  };
  const confirmImport = async () => {
    const result = mergeImport(current.current.entries, preview.added);
    const ok = await perform(() => transact({ type: 'import', entries: result.added }), `已导入 ${result.added.length} 个；跳过 ${preview.skipped + result.skipped} 个重复、${preview.invalid} 个空邮箱`);
    if (ok) { setModal(null); setPaste(''); setPreview(null); }
  };
  const groups = data.groups || [], tags = [...new Set(data.entries.flatMap(e => e.tags))].sort();
  const ready = data.entries.filter(e => !issuesOf(e).length && effectiveStatus(e, data.settings) === 'available');
  const coolingCount = data.entries.filter(e => effectiveStatus(e, data.settings) === 'used').length;
  const incompleteCount = data.entries.filter(e => issuesOf(e).length > 0).length;
  const filtered = data.entries.filter(entry => { const query = search.trim().toLowerCase(); return (!query || [entry.email, entry.browser, entry.profile, entry.displayId, entry.launchUrl, entry.notes, entry.group, ...entry.tags].join(' ').toLowerCase().includes(query)) && (!group || (group === '__none' ? !entry.group : entry.group === group)) && (!tag || entry.tags.includes(tag)); });
  if (sort !== 'original') filtered.sort((a, b) => {
    if (!a.browser || !b.browser) return Number(!a.browser) - Number(!b.browser);
    return a.browser.localeCompare(b.browser, 'en', { sensitivity: 'base', numeric: true }) * (sort === 'browser-asc' ? 1 : -1);
  });
  const selectedVisible = filtered.filter(e => selected.has(e.id)).length;
  const toggleSelect = id => setSelected(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const changeForm = (key, value) => setForm(previous => ({ ...previous, [key]: value }));
  const field = (key, label, input, full = false) => <div className={`field ${full ? 'full' : ''}`} key={key}><label>{modal?.type === 'bulk' && <input aria-label={`修改${label}`} type="checkbox" checked={enabled.has(key)} onChange={e => setEnabled(prev => { const next = new Set(prev); e.target.checked ? next.add(key) : next.delete(key); return next; })}/>} {label}</label><div className={modal?.type === 'bulk' && !enabled.has(key) ? 'field-disabled' : ''}>{input}</div></div>;
  const textField = (key, label, placeholder, full = false, type = 'text') => field(key, label, <input aria-label={label} type={type} autoComplete={type === 'password' ? 'new-password' : 'off'} value={form[key] ?? ''} onChange={e => changeForm(key, e.target.value)} placeholder={placeholder} disabled={busy || (modal?.type === 'bulk' && !enabled.has(key))}/>, full);
  const openImport = () => { setPreview(null); setImportError(''); setModal({ type: 'import' }); };
  const bulkIds = () => selected.size ? [...selected] : filtered.map(e => e.id);
  const openLaunchPages = () => { setForm({ launchUrl: '' }); setModal({ type: 'launchPages', ids: bulkIds() }); };
  const addGroup = async event => {
    event.preventDefault(); setGroupError(''); setBusy(true);
    const version = generation.current;
    try { await transact({ type: 'group-add', name: newGroup }); if (version === generation.current) { setNewGroup(''); notify('分组已添加'); } }
    catch (e) { if (version === generation.current) setGroupError(e.message); }
    finally { setBusy(false); }
  };
  const assignGroup = name => perform(() => transact({ type: 'update', ids: [...selected], patch: { group: name } }), name ? `所选账号已移入 ${name}` : '所选账号已移出分组');
  const filterGroup = name => { setGroup(name); setGroupMenuOpen(false); };
  const cycleSort = () => setSort(value => value === 'original' ? 'browser-asc' : value === 'browser-asc' ? 'browser-desc' : 'original');
  const changeVaultPassword = async e => {
    e.preventDefault(); setFormError('');
    if (form.newPassword !== form.confirmPassword) { setFormError('两次输入的新密码不一致'); return; }
    setBusy(true);
    try { const result = await window.emailManager.changeVaultPassword(form.currentPassword, form.newPassword); if (!result.ok) throw new Error(result.error); setModal(null); setForm(EMPTY); notify('软件密码已修改'); }
    catch (e) { if (!authRef.current.locked) setFormError(e.message); }
    finally { setBusy(false); }
  };
  const lockNow = async () => { const result = await window.emailManager.lockVault(); if (!result.ok) notify(result.error, true); else purge(); };
  const groupDropdown = <div className="group-control" ref={groupMenuRef}>
    <button className={`button ${groupMenuOpen ? 'is-open' : ''}`} ref={groupTriggerRef} aria-expanded={groupMenuOpen} aria-controls="account-group-dropdown" onClick={() => { setGroupMenuOpen(value => !value); setGroupError(''); }}><Folder size={18}/>账号分组<ChevronDown size={16}/></button>
    {groupMenuOpen && <section id="account-group-dropdown" className="group-menu" role="dialog" aria-label="分组管理">
      <header className="group-menu-head"><strong>分组管理</strong><button className="icon-button" aria-label="关闭分组菜单" onClick={() => { setGroupMenuOpen(false); groupTriggerRef.current?.focus(); }}><X size={17}/></button></header>
      <div className="group-filters"><button className={!group ? 'group-filter active' : 'group-filter'} data-group-first onClick={() => filterGroup('')}>全部分组<span>{data.entries.length}</span></button><button className={group === '__none' ? 'group-filter active' : 'group-filter'} aria-label="筛选未分组" onClick={() => filterGroup('__none')}>未分组<span>{data.entries.filter(e => !e.group).length}</span></button></div>
      <div className="group-list">{groups.length ? groups.map(name => <div className={`group-item ${group === name ? 'active' : ''}`} key={name}>
        <button className="group-name-button" aria-label={`筛选分组 ${name}`} title={name} onClick={() => filterGroup(name)}><Folder size={15}/><span>{name}</span><small>{data.entries.filter(e => e.group === name).length}</small></button>
        <button className="icon-button" aria-label={`将已选账号移入 ${name}`} title={`将已选 ${selected.size} 个账号移入 ${name}`} disabled={busy || !selected.size} onClick={() => assignGroup(name)}><FolderInput size={17}/></button>
        <button className="icon-button danger" aria-label={`删除分组 ${name}`} title={`删除分组 ${name}`} disabled={busy} onClick={() => { setGroupMenuOpen(false); setModal({ type: 'deleteGroup', name }); }}><Trash2 size={17}/></button>
      </div>) : <p className="group-empty">还没有分组，在下方添加。</p>}</div>
      <div className="group-selection"><span>{selected.size ? `已选 ${selected.size} 个账号，点击文件夹箭头移入分组。` : '勾选账号后，可直接移入或移出分组。'}</span><button className="text-button" disabled={busy || !selected.size} onClick={() => assignGroup('')}>移出分组</button></div>
      <form className="group-add" onSubmit={addGroup}><input aria-label="新分组名称" maxLength={80} value={newGroup} onChange={e => { setNewGroup(e.target.value); setGroupError(''); }} placeholder="输入新分组名称" disabled={busy}/><button className="button primary" disabled={busy || !newGroup.trim()}><Plus size={16}/>添加分组</button></form>
      {groupError && <p className="error-text" role="alert">{groupError}</p>}
    </section>}
  </div>;
  const dialogs = <>
    {modal && ['edit', 'new', 'bulk', 'notes'].includes(modal.type) && <Modal title={modal.type === 'bulk' ? `批量编辑 · ${modal.ids.length} 个账号` : modal.type === 'notes' ? '备注信息' : modal.type === 'new' ? '添加账号' : '编辑账号资料'} subtitle={modal.type === 'bulk' ? '只修改已勾选的字段；勾选后留空可清除。' : '启动网页可留空，留空时直接打开浏览器。'} onClose={closeModal}>
      <form onSubmit={saveEditor} autoComplete="off"><div className="form-grid">
        {modal.type !== 'notes' && <>
          {modal.type !== 'bulk' && textField('email', '邮箱资料', '邮箱地址或邮箱链接', true)}
          {textField('displayId', '编号', '手动填写，可留空')}
          {field('browser', '浏览器', <select aria-label="浏览器" disabled={busy || (modal.type === 'bulk' && !enabled.has('browser'))} value={form.browser} onChange={e => changeForm('browser', e.target.value)}><option value="">请选择浏览器</option>{form.browser && !BROWSERS.includes(form.browser) && <option value={form.browser}>{form.browser}（待确认）</option>}{BROWSERS.map(b => <option key={b}>{b}</option>)}</select>)}
          {textField('profile', 'Profile', '可选，如 Profile 43 / Default')}
          {field('cooldownHours', '冷却小时', <input aria-label="冷却小时" type="number" min="0.01" max="8760" step="any" placeholder={`留空跟随默认 ${data.settings.cooldownHours} 小时`} value={form.cooldownHours} onChange={e => changeForm('cooldownHours', e.target.value)} disabled={busy || (modal.type === 'bulk' && !enabled.has('cooldownHours'))}/>)}
          {textField('launchUrl', '启动网页', '可留空，直接打开浏览器', true)}
          {field('group', '分组', <><input aria-label="分组" list="account-group-options" value={form.group} onChange={e => changeForm('group', e.target.value)} placeholder="选择已有分组或填写新名称" disabled={busy || (modal.type === 'bulk' && !enabled.has('group'))}/><datalist id="account-group-options">{groups.map(name => <option key={name} value={name}/>)}</datalist></>)}{textField('tags', '标签', '多个标签用逗号分隔')}
          {modal.type !== 'bulk' && <>{textField('password', '账号密码', '填写邮箱登录密码', false, 'password')}{textField('totpSecret', 'TOTP密钥', 'Base32 密钥或 otpauth 链接', false, 'password')}<p className="field-note full">密码与 TOTP 密钥加密保存；列表中点击 TOTP 复制当前 6 位验证码。</p></>}
        </>}
        {field('notes', '备注', <textarea aria-label="备注" rows={3} value={form.notes} onChange={e => changeForm('notes', e.target.value)} placeholder="记录用途或注意事项…" disabled={busy || (modal.type === 'bulk' && !enabled.has('notes'))}/>, true)}
      </div>
      {modal.type !== 'bulk' && modal.type !== 'notes' && issuesOf(form).length > 0 && <div className="inline-notice"><AlertCircle size={17}/>{issuesOf(form).join('、')}；保存后可继续编辑。</div>}
      {formError && <p className="error-text" role="alert">{formError}</p>}
      <footer className="modal-footer"><button type="button" className="button" onClick={closeModal} disabled={busy}>取消</button><button className="button primary" disabled={busy}><Check size={17}/>{busy ? '保存中…' : '保存资料'}</button></footer></form>
    </Modal>}
    {modal?.type === 'settings' && <Modal title="冷却设置" subtitle="账号可单独设置冷却时间；留空的账号跟随默认值。" onClose={closeModal}><form onSubmit={async e => { e.preventDefault(); if (await perform(() => transact({ type: 'settings', cooldownHours: form.cooldownHours }), '默认冷却时间已更新')) { setModal(null); setForm(EMPTY); } }}><div className="form-grid">{field('cooldownHours', '默认冷却小时', <input aria-label="默认冷却小时" type="number" min="0.01" max="8760" step="any" required value={form.cooldownHours} onChange={e => changeForm('cooldownHours', e.target.value)}/>, true)}</div><p className="help-text">例如 0.5 表示 30 分钟。修改后立即重新计算冷却状态。</p><footer className="modal-footer"><button type="button" className="button" onClick={closeModal}>取消</button><button className="button primary" disabled={busy}>保存设置</button></footer></form></Modal>}
    {modal?.type === 'launchPages' && <Modal title="批量启动页设定" subtitle={`将修改 ${modal.ids.length} 个${selected.size ? '已选' : '当前筛选'}账号的启动网页；留空可恢复为直接打开浏览器。`} onClose={closeModal}><form onSubmit={async e => { e.preventDefault(); if (await perform(() => transact({ type: 'update', ids: modal.ids, patch: { launchUrl: form.launchUrl } }), '启动网页已更新')) { setModal(null); setForm(EMPTY); } }}><div className="form-grid">{textField('launchUrl', '启动网页', '留空时直接打开浏览器', true)}</div><footer className="modal-footer"><button type="button" className="button" onClick={closeModal}>取消</button><button className="button primary" disabled={busy || !modal.ids.length}>保存启动页</button></footer></form></Modal>}
    {modal?.type === 'password' && <Modal title="修改软件密码" subtitle="修改后请使用新密码解锁，账号资料保持不变。" onClose={closeModal}><form onSubmit={changeVaultPassword}><div className="form-grid">{textField('currentPassword', '当前软件密码', '输入当前软件密码', true, 'password')}{textField('newPassword', '新软件密码', '至少 8 位', true, 'password')}{textField('confirmPassword', '确认新密码', '再次输入新软件密码', true, 'password')}</div>{formError && <p className="error-text" role="alert">{formError}</p>}<footer className="modal-footer"><button type="button" className="button" onClick={closeModal}>取消</button><button className="button primary" disabled={busy}>保存新密码</button></footer></form></Modal>}
    {modal?.type === 'deleteGroup' && <Modal title="删除分组" subtitle={`删除“${modal.name}”后，其中的 ${data.entries.filter(e => e.group === modal.name).length} 个账号将移到未分组。账号、密码和 TOTP 都会保留。`} onClose={closeModal}><footer className="modal-footer"><button className="button" onClick={closeModal}>取消</button><button className="button danger-solid" disabled={busy} onClick={async () => { if (await perform(() => transact({ type: 'group-delete', name: modal.name }), '分组已删除，账号已移到未分组')) setModal(null); }}>确认删除分组</button></footer></Modal>}
    {modal?.type === 'confirm' && <Modal title={modal.action === 'clearAll' ? '清空全部账号' : modal.action === 'delete' ? '确认删除账号' : '批量启动浏览器'} subtitle={modal.action === 'clearAll' ? `将清空全部 ${modal.ids.length} 个账号及其凭据（包含搜索和筛选未显示的账号），无法从界面撤销。` : modal.action === 'delete' ? `将删除 ${modal.ids.length} 个账号及其凭据，无法从界面撤销。` : `将尝试启动 ${selected.size} 个账号，冷却中及未选浏览器的账号会跳过。`} onClose={closeModal}><footer className="modal-footer"><button className="button" onClick={closeModal}>取消</button><button className={`button ${modal.action === 'delete' || modal.action === 'clearAll' ? 'danger-solid' : 'primary'}`} disabled={busy} onClick={async () => { if (modal.action === 'delete' || modal.action === 'clearAll') { if (await perform(() => transact({ type: 'delete', ids: modal.ids }), modal.action === 'clearAll' ? '已清空全部账号' : '已删除所选账号')) setModal(null); } else { setModal(null); startSelected(); } }}>{modal.action === 'clearAll' ? '确认清空全部' : modal.action === 'delete' ? '确认删除' : '确认启动'}</button></footer></Modal>}
    {modal?.type === 'import' && <Modal title="导入账号资料" subtitle="Excel / CSV / TSV 文件或粘贴表格，导入前检查重复和缺项。" wide onClose={closeModal}>
      <div className="import-options"><button className="button" disabled={fileBusy} onClick={() => fileRef.current.click()}><FileSpreadsheet size={19}/>{fileBusy ? '读取文件中…' : '选择 Excel / CSV 文件'}</button><span className="muted">.xlsx / .csv / .tsv · 最大 20 MB</span><input ref={fileRef} type="file" accept=".xlsx,.csv,.tsv" hidden onChange={readFile}/></div>
      {modal.sheets && <label className="sheet-picker">工作表 <select aria-label="工作表" value={modal.sheetIndex} onChange={e => { const index = Number(e.target.value); setModal(prev => ({ ...prev, sheetIndex: index })); try { prepareRows(modal.sheets[index].rows); } catch (error) { setPreview(null); setImportError(error.message); } }}>{modal.sheets.map((sheet, i) => <option key={i} value={i}>{sheet.name}</option>)}</select></label>}
      <label className="paste-label" htmlFor="paste">或者粘贴资料</label><textarea id="paste" className="paste-input" rows={4} value={paste} disabled={fileBusy} onChange={e => { setPaste(e.target.value); setPreview(null); setModal(prev => ({ ...prev, sheets: null })); }} placeholder={'邮箱链接\t浏览器\tProfile\t编号\t启动网页\t备注\t分组\t标签\t冷却小时\nuser@example.com\tChrome\tProfile 43\t001'}/>
      <div className="import-help"><span>支持“密码”“TOTP密钥”表头，凭据会加密保存；启动网页可留空。Excel 每表最多 5 万行、100 列，超限请拆分；旧版 .xls 请另存为 .xlsx。</span><button className="button" disabled={!paste.trim() || fileBusy} onClick={() => { try { prepareRows(parseDelimited(paste)); } catch (e) { setImportError(e.message); } }}>预览粘贴资料</button></div>
      {importError && <p className="error-text" role="alert">{importError}</p>}
      {preview && <div className="preview"><div className="preview-summary"><strong>{preview.added.length} 个可导入</strong><span>{preview.incomplete} 个浏览器资料待完善</span><span>{preview.skipped} 个重复已跳过</span>{preview.invalid > 0 && <span>{preview.invalid} 个空邮箱已跳过</span>}</div><div className="preview-table"><table><thead><tr><th>邮箱资料</th><th>浏览器</th><th>编号</th><th>检查结果</th></tr></thead><tbody>{preview.added.slice(0, 60).map(e => <tr key={e.id}><td>{e.email}</td><td>{e.browser || '未填写'}</td><td>{e.displayId || '未填写'}</td><td><span className={issuesOf(e).length ? 'warning-text' : 'success-text'}>{issuesOf(e).join('、') || '可以启动'}</span></td></tr>)}</tbody></table></div>{preview.added.length > 60 && <p className="help-text">预览前 60 行，确认后导入全部 {preview.added.length} 行。</p>}</div>}
      <footer className="modal-footer"><button className="button" onClick={closeModal} disabled={busy}>取消</button><button className="button primary" disabled={!preview?.added.length || busy || fileBusy} onClick={confirmImport}><Upload size={17}/>确认导入{preview ? ` ${preview.added.length} 个` : ''}</button></footer>
    </Modal>}
  </>;
  if (loadError) return <div className="load-state"><AlertCircle size={32}/><h2>无法读取本地资料</h2><p>{loadError}</p><p>已暂停操作，请检查资料文件后重启软件。</p></div>;
  if (!auth) return <div className="load-state"><LockKeyhole size={32}/><p>正在检查资料库…</p></div>;
  if (auth.locked || !auth.configured) return <AuthGate status={auth} onUnlock={unlock}/>;
  const toastView = toast && <div role="status" className={`toast ${toast.error ? 'error' : ''}`}>{toast.error ? <AlertCircle size={19}/> : <CheckCircle2 size={19}/>}<span>{toast.message}</span><button onClick={() => setToast(null)} aria-label="关闭提示"><X size={18}/></button></div>;
  if (isToolbar) return <div className="toolbar-app"><header className="toolbar-head"><div><strong>N7M</strong><span>快捷栏</span></div><div className="row-actions"><button className="icon-button" title="锁定" onClick={lockNow}><LockKeyhole size={18}/></button><button className="icon-button" title="打开完整管理窗口" onClick={() => window.emailManager.openMainWindow()}><Maximize2 size={18}/></button><button className="icon-button" title={pinned ? '取消置顶' : '始终置顶'} onClick={async () => { const result = await window.emailManager.setToolbarAlwaysOnTop(!pinned); if (result?.ok) setPinned(!pinned); }}>{pinned ? <Pin size={18}/> : <PinOff size={18}/>}</button><button className="icon-button" title="关闭快捷栏" onClick={() => window.emailManager.closeToolbar()}><X size={18}/></button></div></header><div className="toolbar-list">{ready.length ? ready.map(entry => <article className="quick-card" key={entry.id}><div><strong>{entry.displayId || '未编号'}</strong><span title={entry.email}>{entry.email}</span><small>{entry.browser} {entry.profile}</small></div><button className="start-button" disabled={busy} onClick={() => start(entry)}><Play size={16}/>启动</button></article>) : <div className="empty"><Mail size={32}/><p>暂无可启动的账号</p><small>可在主窗口编辑资料或等待冷却结束。</small></div>}</div>{toastView}{dialogs}</div>;
  return <div className="app-shell">
    <header className="app-header"><div className="app-brand"><strong>N7M<span>.</span></strong><div><h1>账号管理</h1><span>Custom Email Management</span></div></div><div className="security-controls"><span className="encrypted-label"><LockKeyhole size={15}/>资料已加密</span><button className="button quiet clear-all-button" disabled={busy || !data.entries.length} onClick={() => { setGroupMenuOpen(false); setModal({ type: 'confirm', action: 'clearAll', ids: data.entries.map(e => e.id) }); }}>清空全部账号</button><button className="button quiet" onClick={() => { setForm({ currentPassword: '', newPassword: '', confirmPassword: '' }); setFormError(''); setModal({ type: 'password' }); }} disabled={busy}><KeyRound size={17}/>修改软件密码</button><button className="button" onClick={lockNow}><LockKeyhole size={17}/>锁定</button></div></header>
    <main className="page-content"><nav className="control-bar" aria-label="账号控制">{groupDropdown}<button className="button" onClick={() => { setForm({ cooldownHours: data.settings.cooldownHours }); setModal({ type: 'settings' }); }}><Settings2 size={18}/>冷却设置</button><button className="button" onClick={openLaunchPages}><Globe size={18}/>批量启动页设定</button><button className="button" onClick={openImport}><Upload size={18}/>导入资料</button><button className="button primary" onClick={() => openEditor(null, 'new')}><Plus size={19}/>添加账号</button><button className="button" onClick={() => perform(async () => { const result = await window.emailManager.openToolbar(); if (!result.ok) throw new Error(result.error); })}><PanelTop size={18}/>打开快捷栏</button><div className="control-spacer"/><button className="button quiet" disabled={busy || !data.entries.length} onClick={() => exportData()}><Download size={17}/>导出资料</button></nav>
      <section className="profile-help" aria-label="浏览器 Profile 查看方法"><div className="profile-links"><span className="profile-help-label"><Globe size={17}/>查看 Profile</span>{PROFILE_PAGES.map(page => <button className="profile-copy" key={page.browser} aria-label={`${page.browser} · ${page.url}`} title={`复制 ${page.url}`} disabled={busy} onClick={() => copyProfilePage(page)}><strong>{page.browser}</strong><code>{page.url}</code><Copy size={14} aria-hidden="true"/></button>)}</div><p>先切换到目标浏览器配置，再复制对应地址到该浏览器地址栏打开。将“Profile Path / 个人资料路径”的末级目录（如 <code>Default</code>、<code>Profile 43</code>）填入 Profile；“系统默认”请按实际浏览器选择上方地址。</p></section>
      {auth.notice && <div className="legacy-notice" role="status"><AlertCircle size={18}/>{auth.notice}</div>}
      <section className="accounts-panel"><div className="account-summary" aria-label="账号统计"><span>全部账号 <strong>{data.entries.length}</strong></span><span className="summary-ready">可启动 <strong>{ready.length}</strong></span><span className="summary-cooling">冷却中 <strong>{coolingCount}</strong></span><span className="summary-incomplete">待完善 <strong>{incompleteCount}</strong></span><small>默认冷却 {data.settings.cooldownHours} 小时</small></div><div className="filters"><div className="search-box"><Search size={19}/><input aria-label="搜索账号" placeholder="搜索邮箱、编号、浏览器、备注…" value={search} onChange={e => setSearch(e.target.value)}/>{search && <button className="icon-button" aria-label="清除搜索" onClick={() => setSearch('')}><X size={17}/></button>}</div><select aria-label="浏览器排序" value={sort} onChange={e => setSort(e.target.value)}><option value="original">导入顺序</option><option value="browser-asc">浏览器类型 A → Z</option><option value="browser-desc">浏览器类型 Z → A</option></select>{tags.length > 0 && <select aria-label="标签筛选" value={tag} onChange={e => setTag(e.target.value)}><option value="">全部标签</option>{tags.map(t => <option key={t}>{t}</option>)}</select>}{group && <button className="filter-chip" onClick={() => setGroup('')}>{group === '__none' ? '未分组' : group}<X size={14}/></button>}{(search || group || tag) && <button className="text-button" onClick={() => { setSearch(''); setGroup(''); setTag(''); }}>重置筛选</button>}</div>
      {selected.size > 0 && <div className="bulk-bar"><strong>已选 {selected.size} 个</strong><button onClick={openBulk} disabled={busy}><Pencil size={16}/>批量编辑</button><button onClick={() => setModal({ type: 'confirm', action: 'start' })} disabled={busy}><Play size={16}/>批量启动</button><button onClick={() => perform(() => transact({ type: 'reset', ids: [...selected] }), '所选账号已恢复可用')} disabled={busy}><RotateCcw size={16}/>恢复可用</button><button onClick={() => exportData([...selected])} disabled={busy}><Download size={16}/>导出</button><button className="danger" onClick={() => setModal({ type: 'confirm', action: 'delete', ids: [...selected] })} disabled={busy}><Trash2 size={16}/>删除</button><button className="cancel-selection" onClick={() => setSelected(new Set())}>取消选择</button></div>}
      <div className="table-scroll"><table className="accounts-table"><thead><tr><th className="select-cell"><Checkbox aria-label="全选当前筛选结果" checked={filtered.length > 0 && selectedVisible === filtered.length} indeterminate={selectedVisible > 0 && selectedVisible < filtered.length} onChange={e => setSelected(prev => { const next = new Set(prev); for (const item of filtered) e.target.checked ? next.add(item.id) : next.delete(item.id); return next; })}/></th><th>软件编号</th><th>邮箱资料 / 密码 / TOTP / 分组</th><th aria-sort={sort === 'browser-asc' ? 'ascending' : sort === 'browser-desc' ? 'descending' : 'none'}><button className="sort-heading" aria-label="按浏览器类型排序" title="点击切换：浏览器 A→Z、Z→A、导入顺序" onClick={cycleSort}>浏览器 / Profile{sort === 'browser-asc' ? <ArrowDown size={15} aria-hidden="true"/> : sort === 'browser-desc' ? <ArrowUp size={15} aria-hidden="true"/> : <ArrowDownUp size={15} aria-hidden="true"/>}</button></th><th>备注</th><th>状态 / 冷却时间</th><th>操作</th></tr></thead><tbody>{filtered.map(entry => {
        const issues = issuesOf(entry), used = effectiveStatus(entry, data.settings) === 'used';
        const remaining = Math.max(0, hoursOf(entry, data.settings) * 3600000 - (Date.now() - entry.usedAt));
        return <tr key={entry.id} className={selected.has(entry.id) ? 'selected' : ''}>
          <td className="select-cell"><input type="checkbox" aria-label={`选择 ${entry.displayId || entry.email}`} checked={selected.has(entry.id)} onChange={() => toggleSelect(entry.id)}/></td>
          <td><span className={`account-id ${!entry.displayId ? 'muted' : ''}`}>{entry.displayId || '未填写'}</span></td>
          <td><div className="account-info"><div className="email-line"><button className="email-text" title="点击复制邮箱资料" onClick={() => copy(entry)} disabled={busy}>{entry.email}</button><button className="icon-button copy-button" title="复制邮箱资料" onClick={() => copy(entry)} disabled={busy}><Copy size={15}/></button></div><div className="account-meta"><button className="credential-link" disabled={busy || !entry.hasPassword} title={entry.hasPassword ? '复制账号密码' : '尚未设置，请在编辑中添加密码'} onClick={() => copySecret(entry, 'password')}>密码</button><span className="meta-separator">/</span><button className="credential-link" disabled={busy || !entry.hasTotp} title={entry.hasTotp ? '复制当前 TOTP 验证码' : '尚未设置，请在编辑中添加 TOTP 密钥'} onClick={() => copySecret(entry, 'totp')}>TOTP</button><span className="meta-separator">/</span><button className="group-label" title="按此分组筛选账号" onClick={() => filterGroup(entry.group || '__none')}>{entry.group || '未分组'}</button>{entry.tags.map(t => <button className="tag" key={t} onClick={() => setTag(t)}>{t}</button>)}</div></div></td>
          <td><span className={`browser-label ${!entry.browser ? 'missing' : ''}`}>{entry.browser || '未设置浏览器'}</span><small className="cell-sub">{entry.profile || '默认 Profile'}</small></td>
          <td><button className={`notes-button ${entry.notes ? 'has-note' : ''}`} title={entry.notes || '添加备注'} onClick={() => openEditor(entry, 'notes')}><StickyNote size={17}/><span>{entry.notes || '添加备注'}</span></button></td>
          <td><div className="status-stack">{issues.length > 0 && <span className="status-pill warning" title={issues.join('、')}><AlertCircle size={13}/>待完善</span>}{used ? <><span className="status-pill cooling"><Clock3 size={13}/>冷却中</span><small title={`使用于 ${dateTime(entry.usedAt)}；已用 ${elapsed(Date.now() - entry.usedAt)}`}>剩余 {elapsed(remaining)}</small></> : <span className={`status-pill ${issues.length ? 'neutral' : 'available'}`}><span className="status-dot"/>{issues.length ? '未启动' : '就绪'}</span>}<small>冷却 {hoursOf(entry, data.settings)} 小时</small></div></td>
          <td><div className="row-actions"><button className="start-button" disabled={busy || used} title={entry.launchUrl ? `打开 ${entry.launchUrl}` : '直接打开浏览器'} onClick={() => start(entry)}><Play size={16}/>启动</button><button className="icon-button" title="编辑账号" disabled={busy} onClick={() => openEditor(entry)}><Pencil size={18}/></button>{used && <button className="icon-button" title="撤销使用，恢复可用" disabled={busy} onClick={() => perform(() => transact({ type: 'reset', ids: [entry.id] }), '已恢复可用')}><RotateCcw size={18}/></button>}<button className="icon-button danger" title="删除账号" disabled={busy} onClick={() => setModal({ type: 'confirm', action: 'delete', ids: [entry.id] })}><Trash2 size={18}/></button></div></td>
        </tr>;
      })}</tbody></table></div>
      {!filtered.length && <div className="empty"><Mail size={32}/><h3>{data.entries.length ? '没有匹配的账号' : '添加或导入你的第一个账号'}</h3><p>{data.entries.length ? '试试其他关键词，或重置筛选条件。' : '所有账号都将在这里集中管理。'}</p>{!data.entries.length && <button className="button primary" onClick={openImport}><Upload size={17}/>导入账号资料</button>}</div>}
      <footer className="table-footer"><span>显示 {filtered.length} / {data.entries.length} 个账号{selected.size ? ` · 已选 ${selected.size} 个` : ''}</span><span><LockKeyhole size={14}/>加密保存 · 锁屏自动锁定</span></footer></section>
    </main>{toastView}{dialogs}
  </div>;
}
