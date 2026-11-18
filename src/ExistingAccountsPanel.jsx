import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, FileSearch, Search, X } from 'lucide-react';
import { tagsOf } from './model.mjs';
import './existing-accounts.css';

const PAGE_SIZE = 50;
const valueOf = value => String(value ?? '').trim();

export default function ExistingAccountsPanel({ entries = [], onClose }) {
  const [search, setSearch] = useState(''), [browser, setBrowser] = useState(''), [group, setGroup] = useState('');
  const [page, setPage] = useState(1), [selectedId, setSelectedId] = useState('');
  const [feedback, setFeedback] = useState(null), [copying, setCopying] = useState(false);
  const searchRef = useRef(null), active = useRef(true), timer = useRef(null), id = useId();
  useEffect(() => {
    active.current = true;
    const previous = document.activeElement;
    searchRef.current?.focus();
    return () => { active.current = false; clearTimeout(timer.current); previous?.focus(); };
  }, []);

  const browsers = useMemo(() => [...new Set(entries.map(entry => valueOf(entry.browser)).filter(Boolean))].sort(), [entries]);
  const groups = useMemo(() => [...new Set(entries.map(entry => valueOf(entry.group)).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')), [entries]);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return entries.filter(entry => {
      if (browser && entry.browser !== browser) return false;
      if (group && (group === '__none' ? !!valueOf(entry.group) : entry.group !== group)) return false;
      // Deliberately name only public account fields. Raw passwords, TOTP
      // secrets and window identity metadata never participate in this view.
      return !query || [entry.email, entry.displayId, entry.browser, entry.profile, entry.group, entry.notes, ...tagsOf(entry.tags)]
        .map(valueOf).join(' ').toLocaleLowerCase().includes(query);
    });
  }, [entries, search, browser, group]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)), currentPage = Math.min(page, pages);
  const start = (currentPage - 1) * PAGE_SIZE, visible = filtered.slice(start, start + PAGE_SIZE);
  const selected = useMemo(() => entries.find(entry => entry.id === selectedId), [entries, selectedId]);
  useEffect(() => { if (selectedId && !selected) setSelectedId(''); }, [selectedId, selected]);
  useEffect(() => { if (browser && !browsers.includes(browser)) setBrowser(''); if (group && group !== '__none' && !groups.includes(group)) setGroup(''); }, [browsers, groups, browser, group]);
  const filter = (setter, value) => { setter(value); setPage(1); };
  const reset = () => { setSearch(''); setBrowser(''); setGroup(''); setPage(1); };
  const copy = async (value, label) => {
    if (copying || !value) return;
    setCopying(true); clearTimeout(timer.current); setFeedback(null);
    try {
      if (!window.emailManager?.copyText) throw new Error('请在桌面软件中复制资料');
      const result = await window.emailManager.copyText(String(value));
      if (!result.ok) throw new Error(result.error || '复制失败，请重试');
      if (active.current) setFeedback({ message: `${label}已复制`, error: false });
    } catch (error) {
      if (active.current) setFeedback({ message: error.message || '复制失败，请重试', error: true });
    } finally {
      if (active.current) {
        setCopying(false);
        timer.current = setTimeout(() => { if (active.current) setFeedback(null); }, 4000);
      }
    }
  };
  const copyButton = (value, label) => value ? <button type="button" className="existing-copy-button" disabled={copying} aria-label={`复制已有账号${label}`} title={`复制${label}`} onClick={() => copy(value, label)}><Copy size={13}/></button> : null;

  return <section className="existing-accounts-panel" aria-label="已有账号查询">
    <header className="existing-accounts-head"><div><h3 id={`${id}-title`}><FileSearch size={17}/>已有账号 <small>共 {entries.length} 个</small></h3><p>查询历史资料不会清空左侧录入内容。</p></div><button type="button" className="icon-button" aria-label="收起已有账号" title="收起已有账号" onClick={onClose}><X size={18}/></button></header>
    <div className="existing-accounts-filters"><label className="existing-accounts-search"><Search size={15}/><input ref={searchRef} type="search" aria-label="已有账号搜索" value={search} onChange={event => filter(setSearch, event.target.value)} placeholder="搜索邮箱、编号、Profile、备注…" autoComplete="off"/>{search && <button type="button" aria-label="清除已有账号搜索" onClick={() => filter(setSearch, '')}><X size={14}/></button>}</label>
      <div className="existing-accounts-selects"><select aria-label="已有账号浏览器筛选" value={browser} onChange={event => filter(setBrowser, event.target.value)}><option value="">全部浏览器</option>{browsers.map(name => <option key={name} value={name}>{name}</option>)}</select><select aria-label="已有账号分组筛选" value={group} onChange={event => filter(setGroup, event.target.value)}><option value="">全部分组</option><option value="__none">未分组</option>{groups.map(name => <option key={name} value={name}>{name}</option>)}</select>{(search || browser || group) && <button type="button" className="existing-reset" onClick={reset}>重置</button>}</div>
    </div>
    {selected && <section className="existing-account-detail" aria-label="已有账号详情"><div className="existing-detail-heading"><strong>账号详情</strong><button type="button" aria-label="收起账号详情" title="收起账号详情" onClick={() => setSelectedId('')}><X size={15}/></button></div><dl>
      <dt>邮箱</dt><dd><span>{selected.email}</span>{copyButton(selected.email, '邮箱')}</dd>
      <dt>软件编号</dt><dd>{selected.displayId || '未编号'}</dd>
      <dt>浏览器</dt><dd>{selected.browser || '未设置浏览器'}</dd>
      <dt>Profile</dt><dd><span>{selected.profile || '默认配置'}</span>{copyButton(selected.profile, 'Profile')}</dd>
      <dt>分组</dt><dd>{selected.group || '未分组'}</dd>
      {tagsOf(selected.tags).length > 0 && <><dt>标签</dt><dd>{tagsOf(selected.tags).join('、')}</dd></>}
      {selected.launchUrl && <><dt>启动网页</dt><dd><span>{selected.launchUrl}</span>{copyButton(selected.launchUrl, '启动网页')}</dd></>}
      <dt>凭据</dt><dd className="existing-credential-state">密码{selected.hasPassword ? '已设置' : '未设置'} · TOTP {selected.hasTotp ? '已设置' : '未设置'}</dd>
      {selected.cooldownHours != null && <><dt>冷却设置</dt><dd>{selected.cooldownHours} 小时</dd></>}
      <dt>备注</dt><dd className="existing-detail-notes"><span>{selected.notes || '暂无备注'}</span>{copyButton(selected.notes, '备注')}</dd>
    </dl></section>}
    {feedback && <p className={`existing-accounts-feedback ${feedback.error ? 'is-error' : ''}`} role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>}
    <div className="existing-accounts-results" role="list" aria-label="已有账号列表">{visible.length ? visible.map(entry => <div role="listitem" key={entry.id}><button type="button" className={`existing-account-row ${entry.id === selectedId ? 'is-selected' : ''}`} aria-label={`查看已有账号 ${entry.email} ${entry.browser || '未设置浏览器'} ${entry.profile || '默认配置'}`} aria-pressed={entry.id === selectedId} onClick={() => setSelectedId(entry.id)}><span className="existing-row-email">{entry.email}</span><span className="existing-row-meta"><small>{entry.displayId || '未编号'}</small><span>{entry.browser || '未设置浏览器'}{entry.profile ? ` · ${entry.profile}` : ''}</span>{entry.group && <small>{entry.group}</small>}</span>{entry.notes && <span className="existing-row-notes">{entry.notes}</span>}</button></div>) : <div className="existing-accounts-empty"><FileSearch size={24}/><p>{entries.length ? '没有匹配的历史账号' : '还没有已保存的账号'}</p><small>{entries.length ? '试试邮箱、Profile、业务备注或其他筛选。' : '新账号保存后会出现在这里。'}</small>{(search || browser || group) && <button type="button" onClick={reset}>重置筛选</button>}</div>}</div>
    <footer className="existing-accounts-pagination"><span>显示 {visible.length ? `${start + 1}–${start + visible.length}` : '0'} / 共 {filtered.length} 个</span><div><button type="button" aria-label="已有账号上一页" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16}/></button><small>{currentPage} / {pages}</small><button type="button" aria-label="已有账号下一页" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16}/></button></div></footer>
  </section>;
}
