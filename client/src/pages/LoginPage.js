import React, { useState, useEffect, useRef } from 'react';
import { appLogin, appSignup } from '../utils/api';

function pwStrength(pw) {
  if (!pw) return null;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  if (s <= 1) return { label: 'Weak',   pct: 33, color: 'var(--danger)' };
  if (s <= 3) return { label: 'Medium', pct: 66, color: 'var(--warn)' };
  return           { label: 'Strong', pct: 100, color: 'var(--success)' };
}

function EyeIcon({ open, size = 14 }) {
  return open
    ? <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
    : <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>;
}

function friendlyError(raw) {
  if (!raw) return 'Something went wrong. Please try again.';
  const m = String(raw).toLowerCase();
  if (m.includes('nysonian.com')) return 'Only @nysonian.com email addresses can sign up.';
  if (m.includes('invalid') || m.includes('incorrect') || m.includes('wrong')) return 'Incorrect email or password.';
  if (m.includes('already') || m.includes('exists')) return 'An account with this email already exists.';
  if (m.includes('password') && m.includes('short')) return 'Password must be at least 6 characters.';
  if (m.includes('email')) return 'Please enter a valid email address.';
  return raw;
}

export default function LoginPage({ onLogin }) {
  const [mode, setMode]       = useState('signin');
  const [name, setName]       = useState('');
  const [email, setEmail]     = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]   = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const emailRef = useRef(null);
  const nameRef  = useRef(null);
  const strength = mode === 'signup' ? pwStrength(password) : null;

  useEffect(() => {
    const t = setTimeout(() => {
      (mode === 'signup' ? nameRef : emailRef).current?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [mode]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = mode === 'signin'
        ? await appLogin(email, password)
        : await appSignup(email, password, name);
      if (res.error) { setError(friendlyError(res.error)); return; }
      if (res.ok && res.user) onLogin(res.user);
    } catch {
      setError('Connection error. Please check your network.');
    } finally {
      setLoading(false);
    }
  }

  const input = {
    width: '100%', padding: '9px 12px',
    background: 'var(--bg3)', border: '1px solid var(--border2)',
    borderRadius: 'var(--radius)', color: 'var(--text)',
    fontSize: 13, fontFamily: 'var(--font-body)',
    outline: 'none', transition: 'border-color .12s',
    boxSizing: 'border-box',
  };

  const label = {
    display: 'block', fontSize: 11, fontWeight: 500,
    color: 'var(--text3)', marginBottom: 5, letterSpacing: '.2px',
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', background: 'var(--bg)',
    }}>
      <div style={{
        width: '100%', maxWidth: 380,
        background: 'var(--bg2)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '32px 28px',
        boxShadow: 'var(--shadow)',
        margin: '16px',
      }}>

        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 6, flexShrink: 0,
            background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700, color: '#fff',
          }}>N</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.2 }}>Nysonian</div>
            <div style={{ fontSize: 10, color: 'var(--text3)', letterSpacing: '.1em', textTransform: 'uppercase' }}>Marketing Hub</div>
          </div>
        </div>

        {/* Heading */}
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', margin: 0, lineHeight: 1.2 }}>
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </h1>
          <p style={{ fontSize: 12, color: 'var(--text3)', margin: '4px 0 0' }}>
            {mode === 'signin'
              ? 'Enter your credentials to continue'
              : 'Set up your dashboard access'}
          </p>
        </div>

        {/* Mode tabs */}
        <div style={{
          display: 'flex', background: 'var(--bg3)',
          borderRadius: 'var(--radius)', padding: 2,
          marginBottom: 22, border: '1px solid var(--border)',
        }}>
          {[['signin', 'Sign In'], ['signup', 'Sign Up']].map(([m, lbl]) => (
            <button key={m} type="button" onClick={() => { setMode(m); setError(''); setPassword(''); }}
              style={{
                flex: 1, padding: '6px 0', border: 'none', cursor: 'pointer',
                borderRadius: 5, fontSize: 12, fontWeight: mode === m ? 600 : 400,
                fontFamily: 'var(--font-body)', transition: 'all .12s',
                background: mode === m ? 'var(--bg2)' : 'transparent',
                color: mode === m ? 'var(--text)' : 'var(--text3)',
                boxShadow: mode === m ? 'var(--shadow-sm)' : 'none',
              }}>
              {lbl}
            </button>
          ))}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {mode === 'signup' && (
            <div>
              <label style={label}>Full Name</label>
              <input ref={nameRef} type="text" value={name} onChange={e => setName(e.target.value)}
                placeholder="Your name" required autoComplete="name" style={input}
                onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                onBlur={e => e.target.style.borderColor = 'var(--border2)'} />
            </div>
          )}

          <div>
            <label style={label}>Email</label>
            <input ref={emailRef} type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@company.com" required autoComplete="email" style={input}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border2)'} />
          </div>

          <div>
            <label style={label}>Password</label>
            <div style={{ position: 'relative' }}>
              <input
                type={showPw ? 'text' : 'password'}
                value={password} onChange={e => setPassword(e.target.value)}
                placeholder={mode === 'signup' ? 'Min. 6 characters' : 'Password'}
                required
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                style={{ ...input, paddingRight: 38 }}
                onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                onBlur={e => e.target.style.borderColor = 'var(--border2)'}
              />
              <button type="button" onClick={() => setShowPw(v => !v)} tabIndex={-1}
                style={{
                  position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text3)', padding: 2, display: 'flex', alignItems: 'center',
                }}>
                <EyeIcon open={showPw} />
              </button>
            </div>

            {/* Password strength */}
            {mode === 'signup' && password && strength && (
              <div style={{ marginTop: 7 }}>
                <div style={{ display: 'flex', gap: 3, marginBottom: 3 }}>
                  {[33, 66, 100].map(t => (
                    <div key={t} style={{
                      flex: 1, height: 2, borderRadius: 2,
                      background: strength.pct >= t ? strength.color : 'var(--border2)',
                      transition: 'background .2s',
                    }} />
                  ))}
                </div>
                <div style={{ fontSize: 10, color: strength.color, fontWeight: 500 }}>{strength.label}</div>
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div style={{
              padding: '9px 12px', fontSize: 12, color: 'var(--danger)',
              background: 'var(--danger-dim)', border: '1px solid rgba(192,57,43,.25)',
              borderRadius: 'var(--radius)', lineHeight: 1.5,
            }}>
              {error}
            </div>
          )}

          {/* Submit */}
          <button type="submit" disabled={loading} style={{
            marginTop: 2, padding: '10px',
            background: 'var(--accent)',
            border: 'none', borderRadius: 'var(--radius)',
            color: '#fff', fontSize: 13, fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.7 : 1,
            fontFamily: 'var(--font-body)',
            transition: 'opacity .12s, filter .12s',
          }}
            onMouseEnter={e => { if (!loading) e.currentTarget.style.background = 'var(--accent-hover)'; }}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--accent)'}
          >
            {loading
              ? <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
                  <span style={{ width: 11, height: 11, border: '2px solid rgba(255,255,255,.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin .7s linear infinite', display: 'inline-block' }} />
                  {mode === 'signin' ? 'Signing in...' : 'Creating account...'}
                </span>
              : mode === 'signin' ? 'Sign In' : 'Create Account'
            }
          </button>
        </form>

        {mode === 'signup' && (
          <p style={{ fontSize: 11, color: 'var(--text3)', textAlign: 'center', marginTop: 16, lineHeight: 1.6 }}>
            Only <strong style={{ color: 'var(--text2)' }}>@nysonian.com</strong> email addresses can sign up.
            The first account becomes admin.
          </p>
        )}
      </div>
    </div>
  );
}
