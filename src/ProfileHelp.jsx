import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, Globe } from 'lucide-react';
import './profile-help.css';

const PROFILE_PAGES = [
  { browser: 'Chrome', url: 'chrome://version' },
  { browser: 'Edge', url: 'edge://version' },
  { browser: 'Brave', url: 'brave://version' },
  { browser: 'Firefox', url: 'about:profiles' },
];

export default function ProfileHelp({ disabled = false, className = '', onCopy }) {
  const [copying, setCopying] = useState(false), [feedback, setFeedback] = useState(null);
  const active = useRef(true), timer = useRef(null);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; clearTimeout(timer.current); };
  }, []);
  const copy = async page => {
    if (disabled || copying) return;
    setCopying(true); setFeedback(null); clearTimeout(timer.current);
    try {
      const result = await (onCopy ? onCopy(page) : window.emailManager.copyText(page.url));
      if (result === false || result?.ok === false) throw new Error(result?.error || '复制失败，请重试');
      if (active.current) setFeedback({ text: `已复制 ${page.url}，请粘贴到 ${page.browser} 地址栏。`, error: false });
    } catch (error) {
      if (active.current) setFeedback({ text: error.message || '复制失败，请重试', error: true });
    } finally {
      if (active.current) {
        setCopying(false);
        timer.current = setTimeout(() => { if (active.current) setFeedback(null); }, 6000);
      }
    }
  };
  return <details className={`n7m-profile-help ${className}`} aria-label="浏览器 Profile 查看方法">
    <summary><Globe size={15}/><span>查看 Profile</span><small>Chrome · Edge · Brave · Firefox</small><ChevronDown className="n7m-profile-chevron" size={15}/></summary>
    <div className="n7m-profile-content"><div className="n7m-profile-links">{PROFILE_PAGES.map(page => <button type="button" key={page.browser} aria-label={`${page.browser} · ${page.url}`} title={`复制 ${page.url}`} disabled={disabled || copying} onClick={() => copy(page)}><strong>{page.browser}</strong><code>{page.url}</code><Copy size={13} aria-hidden="true"/></button>)}</div>
      <p>Chrome / Edge / Brave：切换到目标配置后查看“Profile Path / 个人资料路径”，填写路径最后一级目录，如 <code>Default</code>、<code>Profile 43</code>、<code>Profile+21</code>，保留目录名中的加号。Firefox：打开 <code>about:profiles</code>，填写对应的配置名称（如 <code>default-release</code>），保留大小写，不填写根目录路径；留空使用默认配置。“系统默认”按实际浏览器选择。</p>
      <p>指定的 Firefox 配置若已在其他窗口运行，请先关闭该配置后再启动；不会强制结束其他配置。</p>
      {feedback && <p className={`n7m-profile-feedback ${feedback.error ? 'is-error' : ''}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    </div>
  </details>;
}
