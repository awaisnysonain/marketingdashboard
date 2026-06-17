import React from 'react';
import PageIntro from '../components/PageIntro';
import { Icons } from '../components/Icons';

const BRANDS = {
  nobl: {
    title: 'NOBL Travel app',
    desc: 'In-app purchases, subscriptions, and mobile revenue for the NOBL Travel app — App Store & Google Play.',
    accent: '#6366f1',
  },
  flo: {
    title: 'Pilates FLO app',
    desc: 'In-app purchases, subscriptions, and mobile revenue for the Pilates FLO app — App Store & Google Play.',
    accent: '#14b8a6',
  },
};

export default function AppComingSoonPage({ brand = 'nobl' }) {
  const cfg = BRANDS[brand] || BRANDS.nobl;

  return (
    <div style={{ padding: '0 4px 32px' }}>
      <PageIntro title={cfg.title} desc={cfg.desc} accent={cfg.accent} />

      <div
        style={{
          marginTop: 48,
          maxWidth: 480,
          marginLeft: 'auto',
          marginRight: 'auto',
          textAlign: 'center',
          padding: '48px 32px',
          background: 'var(--bg2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow)',
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            margin: '0 auto 20px',
            borderRadius: 14,
            background: `${cfg.accent}18`,
            color: cfg.accent,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icons.Smartphone size={28} />
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>
          Coming soon
        </div>
        <p style={{ fontSize: 13, color: 'var(--text3)', lineHeight: 1.6, margin: 0 }}>
          IAP revenue, subscription metrics, and app-store performance will appear here once the mobile data pipeline is connected.
        </p>
      </div>
    </div>
  );
}
