import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ChevronDown, Globe, Github, KeyRound, Mail, ShieldCheck } from 'lucide-react';
import { marketApi } from './api';
import { rememberNativeAuthReturnTo } from './authReturnTo';
import { useLocale, type MessageKey } from './i18n';

export function AccountSignIn() {
  const { t, locale, setLocale } = useLocale();
  const [ticket, setTicket] = useState('');
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [githubEnabled, setGithubEnabled] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | ''>('');
  const [expired, setExpired] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const initial = useRef<Promise<void> | null>(null);
  useEffect(() => { document.title = `OpenBitFun · ${t('signIn')}`; }, [t]);
  useEffect(() => {
    const requestedReturnTo = new URLSearchParams(window.location.search).get('returnTo');
    const nativeReturnTo = rememberNativeAuthReturnTo(requestedReturnTo);
    // Preserve a desktop ticket across reloads without putting its polling secret in the browser.
    if (!initial.current) initial.current = (async () => {
      const fragmentTicket = new URLSearchParams(window.location.hash.slice(1)).get('ticket');
      if (fragmentTicket) {
        const config = await marketApi.config();
        setTicket(fragmentTicket);
        setEmailEnabled(config.emailAuthConfigured === true);
        setGithubEnabled(config.githubAuthConfigured);
      } else {
        const start = await marketApi.startLogin(nativeReturnTo || requestedReturnTo || '/miniapp/');
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#ticket=${encodeURIComponent(start.ticket)}`);
        setTicket(start.ticket); setEmailEnabled(start.emailEnabled); setGithubEnabled(start.githubEnabled);
      }
    })().catch(() => setError('emailStartFailed'));
  }, [t]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const showError = (cause: unknown) => {
    const key = cause && typeof cause === 'object' && 'code' in cause ? cause.code : '';
    if (key === 'login_flow_expired' || key === 'desktop_auth_expired') {
      setExpired(true);
      setError('emailFlowExpired');
      return;
    }
    setError(key === 'email_rate_limit' ? 'emailRateLimited' : key === 'auth_rate_limit' || key === 'auth_capacity' ? 'emailAuthBusy' : key === 'email_delivery_failed' ? 'emailDeliveryFailed' : key === 'invalid_email_code' ? 'emailCodeInvalid' : key === 'invalid_email' ? 'emailInvalid' : 'emailStartFailed');
  };
  async function send(event?: FormEvent) {
    event?.preventDefault(); setBusy(true); setError('');
    try { const sent = await marketApi.sendEmailCode(ticket, email, locale); setChallenge(sent.challengeId); setCode(''); setRetryAt(Date.now() + sent.retryAfterSeconds * 1000); }
    catch (cause) { showError(cause); } finally { setBusy(false); }
  }
  async function verify(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await marketApi.verifyEmailCode(ticket, challenge, code);
      const target = new URL(result.redirectUrl, window.location.origin);
      if (![window.location.origin, 'https://auth.openbitfun.com', 'https://market.openbitfun.com'].includes(target.origin)) throw new Error('Untrusted return URL');
      if (target.origin === 'https://auth.openbitfun.com' && target.pathname === '/complete') target.searchParams.set('locale', locale);
      window.location.assign(target.href);
    } catch (cause) { showError(cause); setBusy(false); }
  }
  async function github() {
    setBusy(true); setError('');
    try { const result = await marketApi.loginGithub(ticket); const url = new URL(result.authorizationUrl);
      if (url.origin !== 'https://github.com' || url.pathname !== '/login/oauth/authorize' || url.username || url.password) throw new Error('Untrusted authorization URL');
      window.location.assign(url.href);
    } catch (cause) { showError(cause); setBusy(false); }
  }
  return <main className="account-auth-page"><div className="account-auth-shell">
    <header className="account-auth-header">
      <div className="account-auth-brand"><img src="/miniapp/assets/openbitfun-email-app-icon.png" alt="" width="36" height="36" /><span>OpenBitFun</span></div>
      <div className="account-auth-language"><Globe size={16} aria-hidden="true" />
        <select aria-label={t('language')} value={locale} onChange={event => setLocale(event.target.value as typeof locale)}>
          <option value="en-US">English</option><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option>
        </select><ChevronDown size={14} aria-hidden="true" />
      </div>
    </header>
    <section className="account-sign-in" aria-labelledby="account-sign-in-title" aria-busy={busy}>
      <div className="account-auth-symbol"><KeyRound size={24} aria-hidden="true" /></div>
      <h1 id="account-sign-in-title">{t('accountSignIn')}</h1><p className="account-auth-intro">{t('emailLoginIntro')}</p>
      {!ticket && !error && <p role="status">{t('authWorking')}</p>}
      {emailEnabled && !expired && <form onSubmit={challenge ? verify : send}>
        <label htmlFor="sign-in-email">{t('emailAddress')}</label>
        <div className="account-auth-field"><Mail size={18} aria-hidden="true" /><input id="sign-in-email" type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} value={email} disabled={busy || !!challenge} onChange={event => setEmail(event.target.value)} /></div>
        {challenge && <><p className="account-auth-notice" role="status">{t('emailCodeSent')}</p><label htmlFor="sign-in-code">{t('emailCode')}</label><div className="account-auth-field"><KeyRound size={18} aria-hidden="true" /><input id="sign-in-code" className="account-auth-code" autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" minLength={8} maxLength={8} required value={code} disabled={busy} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} /></div></>}
        <button className="account-auth-button account-auth-button--primary" type="submit" disabled={busy || !ticket}>{t(busy ? 'authWorking' : challenge ? 'emailVerify' : 'emailSendCode')}<ArrowRight size={18} aria-hidden="true" /></button>
        {challenge && <div className="account-auth-links"><button type="button" disabled={busy || now < retryAt} onClick={() => void send()}>{t(now < retryAt ? 'emailResendWait' : 'emailResend')}</button><button type="button" disabled={busy} onClick={() => { setChallenge(''); setCode(''); setError(''); }}>{t('emailChange')}</button></div>}
      </form>}
      {emailEnabled && githubEnabled && !expired && <div className="account-auth-divider"><span>{t('authOr')}</span></div>}
      {githubEnabled && !expired && <button className="account-auth-button" disabled={busy || !ticket} onClick={() => void github()}><Github size={20} aria-hidden="true" />{t('githubSignIn')}</button>}
      {!!ticket && !emailEnabled && !githubEnabled && <p>{t('emailUnavailable')}</p>}
      {error && <p className="account-auth-error" role="alert">{t(error)}</p>}
    </section>
    <p className="account-auth-footer"><ShieldCheck size={16} aria-hidden="true" />{t('authPrivate')}</p>
  </div></main>;
}
