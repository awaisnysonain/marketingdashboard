import React from 'react';

const Ic = ({children, size=16, className='', style={}}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
    className={className} style={{flexShrink:0,...style}}>
    {children}
  </svg>
);

export const Icons = {
  LayoutDashboard: (p) => <Ic {...p}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="5" rx="1"/></Ic>,
  CalendarDays:    (p) => <Ic {...p}><rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="8" cy="14" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="14" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="18" r="1" fill="currentColor" stroke="none"/></Ic>,
  TrendingUp:      (p) => <Ic {...p}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></Ic>,
  TrendingDown:    (p) => <Ic {...p}><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></Ic>,
  CreditCard:      (p) => <Ic {...p}><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></Ic>,
  BarChart2:       (p) => <Ic {...p}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></Ic>,
  BarChart3:       (p) => <Ic {...p}><path d="M3 3v18h18"/><path d="M7 16h4"/><path d="M7 11h8"/><path d="M7 6h12"/></Ic>,
  Layers:          (p) => <Ic {...p}><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></Ic>,
  CalendarCheck:   (p) => <Ic {...p}><rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="m9 16 2 2 4-4"/></Ic>,
  Package:         (p) => <Ic {...p}><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="m7.5 4.27 9 5.15"/></Ic>,
  Palette:         (p) => <Ic {...p}><circle cx="13.5" cy="6.5" r=".5" fill="currentColor" stroke="none"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" stroke="none"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor" stroke="none"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" stroke="none"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></Ic>,
  Zap:             (p) => <Ic {...p}><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></Ic>,
  Share2:          (p) => <Ic {...p}><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></Ic>,
  Filter:          (p) => <Ic {...p}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></Ic>,
  Tag:             (p) => <Ic {...p}><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" stroke="none"/></Ic>,
  Activity:        (p) => <Ic {...p}><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></Ic>,
  Crosshair:       (p) => <Ic {...p}><circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/></Ic>,
  FileSpreadsheet: (p) => <Ic {...p}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/></Ic>,
  TableRows:       (p) => <Ic {...p}><path d="M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 11h18"/><path d="M3 16h18"/><path d="M3 21h18"/></Ic>,
  Sun:             (p) => <Ic {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></Ic>,
  Moon:            (p) => <Ic {...p}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></Ic>,
  RefreshCw:       (p) => <Ic {...p}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></Ic>,
  LogOut:          (p) => <Ic {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></Ic>,
  Menu:            (p) => <Ic {...p}><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="16" x2="20" y2="16"/></Ic>,
  ChevronLeft:     (p) => <Ic {...p}><path d="m15 18-6-6 6-6"/></Ic>,
  ChevronRight:    (p) => <Ic {...p}><path d="m9 18 6-6-6-6"/></Ic>,
  Grid:            (p) => <Ic {...p}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></Ic>,
};

// Map sheet tab name → icon component
export function sheetIcon(tabName) {
  const n = String(tabName||'').toLowerCase();
  if (n.includes('summary'))                return Icons.LayoutDashboard;
  if (n.includes('daily input'))            return Icons.CalendarDays;
  if (n.includes('daily trend'))            return Icons.TrendingUp;
  if (n.includes('day of week'))            return Icons.CalendarCheck;
  if (n.includes('trial to paid') && n.includes('daily')) return Icons.TableRows;
  if (n.includes('trial to paid'))          return Icons.CreditCard;
  if (n.includes('weekly'))                 return Icons.BarChart2;
  if (n.includes('cohort'))                 return Icons.Layers;
  if (n.includes('product x color') || n.includes('product × color')) return Icons.Palette;
  if (n.includes('by product'))             return Icons.Package;
  if (n.includes('variant'))                return Icons.Zap;
  if (n.includes('channel funnel'))         return Icons.Filter;
  if (n.includes('by channel'))             return Icons.Share2;
  if (n.includes('tier x channel') || n.includes('tier × channel')) return Icons.Tag;
  if (n.includes('fb campaigns') || n.includes('facebook campaign')) return Icons.Activity;
  if (n.includes('fb adsets') || n.includes('adset'))  return Icons.Crosshair;
  if (n.includes('forecast') || n.includes('forcast')) return Icons.TrendingDown;
  return Icons.FileSpreadsheet;
}
