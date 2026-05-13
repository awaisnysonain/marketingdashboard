import React from 'react';

const ERP_URL = 'https://erp.nysonik.com';

export default function AccessDeniedPage({ reason }) {
  // reason: 'no-token' | 'invalid' | 'expired' | 'network'
  const headline =
    reason === 'expired' ? 'Your session has expired' :
    reason === 'invalid' ? 'Sign-in token rejected'   :
    reason === 'network' ? 'Could not verify with the ERP' :
                           'Access requires ERP sign-in';

  const body =
    reason === 'expired'
      ? 'ERP sessions are valid for 2 hours. Open the dashboard again from the Nysonian ERP to refresh.'
      : reason === 'invalid'
        ? 'The sign-in token from the ERP could not be verified. Return to the ERP and re-launch this dashboard.'
        : reason === 'network'
          ? 'We could not reach the ERP server to verify your access. Try again in a moment, or contact your administrator if the issue persists.'
          : 'This dashboard is only accessible from the Nysonian ERP portal. Direct links don’t work outside the ERP.';

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: 24,
    }}>
      <div style={{
        background: 'var(--bg2)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        padding: '36px 40px',
        maxWidth: 480, width: '100%',
        textAlign: 'center',
        boxShadow: 'var(--shadow)',
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%',
          background: 'var(--accent-dim, rgba(99,102,241,0.15))',
          color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 18px',
          fontSize: 28, fontWeight: 700,
        }}>🔒</div>
        <h1 style={{
          fontSize: 20, fontWeight: 700, margin: '0 0 10px',
          color: 'var(--text)', fontFamily: 'var(--font-head)',
        }}>
          {headline}
        </h1>
        <p style={{
          fontSize: 13, color: 'var(--text2)', lineHeight: 1.6,
          margin: '0 0 24px',
        }}>
          {body}
        </p>
        <a
          href={ERP_URL}
          style={{
            display: 'inline-block',
            padding: '10px 22px',
            background: 'var(--accent)',
            color: '#fff',
            borderRadius: 8,
            fontSize: 13, fontWeight: 600,
            textDecoration: 'none',
            transition: 'opacity .15s',
          }}
          onMouseEnter={e => e.currentTarget.style.opacity = '0.9'}
          onMouseLeave={e => e.currentTarget.style.opacity = '1'}
        >
          Open Nysonian ERP →
        </a>
        <div style={{ fontSize: 11, color: 'var(--text4)', marginTop: 22 }}>
          Once signed into the ERP, launch this dashboard from your portal.
        </div>
      </div>
    </div>
  );
}
