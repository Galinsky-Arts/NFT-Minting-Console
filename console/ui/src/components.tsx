import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Route } from './model';

const icons: Record<string, ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  check: <><path d="m8 12 3 3 6-7"/><path d="M12 3 3 7v5c0 5 5 8 9 10 4-2 9-5 9-10V7l-9-4Z"/></>,
  settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  wallet: <><path d="M4 6h14a2 2 0 0 1 2 2v11H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12v3"/><path d="M20 10h-6v5h6M16 12.5h1"/></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
  layers: <><path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/></>,
};
export function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg>;
}
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`notice ${error ? 'notice-error' : ''}`} role={error ? 'alert' : undefined}><Icon name="info"/><div>{children}</div></div>;
}
export function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  const closeRef = useRef(close), dismissRef = useRef<() => void>(() => {});
  closeRef.current = close;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let notified = false;
    const dismiss = () => {
      if (notified) return;
      notified = true;
      // Cancel sensitive work synchronously, before the native queued close
      // event or a late wallet promise can run. Closing the DOM alone is not cancellation.
      try { closeRef.current(); }
      finally { dialog.close(); if (opener?.isConnected) opener.focus(); }
    };
    dismissRef.current = dismiss;
    const onClose = () => { if (!dialog.open) dismiss(); };
    const onCancel = (event: Event) => { event.preventDefault(); dismiss(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const targets = [...dialog.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [tabindex]'
      )].filter(element => element.tabIndex >= 0 && !element.matches(':disabled') &&
        !element.closest('[inert]') && element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== 'hidden');
      if (!targets.length) return;
      const index = targets.indexOf(document.activeElement as HTMLElement);
      const next = index < 0 ? (event.shiftKey ? targets.length - 1 : 0) :
        (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length;
      event.preventDefault();
      targets[next]?.focus();
    };
    dialog.addEventListener('close', onClose);
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('keydown', onKeyDown);
    dialog.showModal();
    return () => {
      notified = true;
      dialog.removeEventListener('close', onClose);
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('keydown', onKeyDown);
      dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return <dialog className="modal" ref={ref} aria-labelledby={id}>
    <div className="modal-heading"><h2 id={id}>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={() => dismissRef.current()}><Icon name="close"/></button></div>
    {children}
  </dialog>;
}
export const navigation: { route: Route; label: string; icon: string }[] = [
  { route: 'releases', label: 'Collections', icon: 'grid' }, { route: 'create', label: 'Create release', icon: 'plus' },
  { route: 'launch', label: 'Deploy & mint', icon: 'plus' },
  { route: 'transactions', label: 'Mint transactions', icon: 'layers' },
  { route: 'marketplace', label: 'Marketplace', icon: 'wallet' },
  { route: 'readiness', label: 'Release readiness', icon: 'check' }, { route: 'settings', label: 'Workspace settings', icon: 'settings' },
];
export function Navigation({ route, close }: { route: Route; close?: () => void }) {
  return <nav aria-label="Workspace">{navigation.map(item => <a key={item.route} href={`#/${item.route}`} aria-current={route === item.route ? 'page' : undefined} onClick={close}><Icon name={item.icon}/><span>{item.label}</span></a>)}</nav>;
}
export function SignInPrompt({ connect, compact = false }: { connect: () => void; compact?: boolean }) {
  return <div className={`empty-state ${compact ? 'compact' : ''}`}>
    <div className="empty-icon"><Icon name="wallet"/></div>
    <h2>Connect to your workspace</h2><p>Sign in with an authorized wallet to load your collections and release status. No transaction or token approval is requested.</p>
    <button className="button primary" onClick={connect}>Connect wallet <Icon name="arrow"/></button>
  </div>;
}
