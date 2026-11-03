import React, { useState } from 'react';
import { LockKeyhole, ShieldCheck, ArrowRight } from 'lucide-react';
import { APP_NAME } from './model.mjs';
export default function AuthGate({ status, onUnlock, error: initialError }) {
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const setup = !status.configured;
  const submit = async event => {
    event.preventDefault(); setError('');
    if (setup && password !== confirmation) { setError('两次输入的软件密码不一致'); return; }
    setBusy(true);
    try { await onUnlock(password, setup); setPassword(''); setConfirmation(''); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <main className="auth-page"><section className="auth-card"><div className="auth-symbol"><LockKeyhole size={30}/></div><div className="auth-brand">N7M</div><p className="auth-product">{APP_NAME}</p><h1>{setup ? '设置软件密码' : '资料库已锁定'}</h1><p className="auth-description">{setup ? status.hasLegacy ? '为现有账号设置密码，资料将迁移到加密资料库。' : '设置软件密码，保护邮箱、登录密码和 TOTP 密钥。' : '输入软件密码，解锁你的账号资料。'}</p>
    <form onSubmit={submit}><label htmlFor="vault-password">软件密码</label><input id="vault-password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} minLength={setup ? 8 : undefined} required autoFocus value={password} onChange={e => setPassword(e.target.value)} disabled={busy} placeholder={setup ? '至少 8 位，请妥善保管' : '输入软件密码'}/>{setup && <><label htmlFor="vault-confirmation">确认软件密码</label><input id="vault-confirmation" type="password" autoComplete="new-password" required value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy}/></>}
    {(error || initialError) && <p className="error-text" role="alert">{error || initialError}</p>}<button className="button primary" disabled={busy}>{busy ? '正在解锁…' : setup ? '设置密码并解锁' : '解锁'}<ArrowRight size={18}/></button></form><p className="auth-footnote"><ShieldCheck size={16}/>{setup ? '请记住软件密码，遗忘后无法解密账号资料。' : '系统锁屏或休眠后自动锁定。'}</p></section></main>;
}
