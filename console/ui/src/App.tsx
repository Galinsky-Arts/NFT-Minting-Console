import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useAuthentication, useWallets } from './auth';
import { configuration, routeFromHash, shortAddress } from './model';
import type { Configuration, Route } from './model';
import { Icon, Notice, Modal, Navigation, navigation } from './components';
import { ReleaseInventory } from './ReleaseInventory';
import { CollectionPlanner } from './CollectionPlanner';
import { ReleaseReadiness } from './ReleaseReadiness';
import { Settings } from './Settings';
import { Dashboard } from './Dashboard';
import { Help } from './Help';
const PublicLaunch = lazy(() => import('./PublicLaunch').then(module => ({default: module.PublicLaunch})));
const Marketplace = lazy(() => import('./Marketplace').then(m => ({ default: m.Marketplace })));
const Collections = lazy(() => import('./Collections').then(m => ({ default: m.Collections })));
const PrivateStudio = lazy(() => import('./PrivateStudio').then(m => ({ default: m.PrivateStudio })));
const MintTransactions = lazy(() => import('./MintTransactions').then(module => ({ default: module.MintTransactions })));

export default function App() {
  const [route, setRoute] = useState<Route>(() => routeFromHash(location.hash));
  const [config, setConfig] = useState<Configuration | null>(null), [configError, setConfigError] = useState(''), [configVersion, setConfigVersion] = useState(0);
  const [walletOpen, setWalletOpen] = useState(false), [menuOpen, setMenuOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), routeChanged = useRef(false);
  const auth = useAuthentication(config), wallets = useWallets();
  useEffect(() => { const change = () => { routeChanged.current = true; setRoute(routeFromHash(location.hash)); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  useEffect(() => { if (routeChanged.current) heading.current?.focus(); }, [route]);
  useEffect(() => {
    const controller = new AbortController(); setConfigError('');
    api('/api/config', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setConfig(configuration(value)); })
      .catch(() => { if (!controller.signal.aborted) { setConfig(null); setConfigError('The workspace configuration could not be loaded. No signing or publishing is available.'); } });
    return () => controller.abort();
  }, [configVersion]);
  useEffect(() => { if (auth.current) setWalletOpen(false); }, [auth.current?.csrf]);
  const openWallet = () => { auth.clearError(); setWalletOpen(true); };
  const page = navigation.find(x => x.route === route)!;
  const current = config && auth.current?.chainId === config.chainId ? auth.current : null;
  return <div className="app-shell">
    <aside className="sidebar"><a href="#/releases" className="brand"><span className="brand-mark">N</span><span>NFT<span className="brand-light"> CONSOLE</span></span></a><span className="sidebar-label">CREATOR WORKSPACE</span><Navigation route={route}/><div className="sidebar-bottom"><Icon name="lock"/><strong>Your keys stay in your wallet.</strong><p>Sign in to manage your releases.<br/>Never share a private key.</p><span className="sidebar-build">{config?.production ? "MAINNET" : "REHEARSAL NETWORK"}</span></div></aside>
    <div className="workspace"><header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Icon name="menu"/></button><span className="breadcrumb">Workspace <span>/</span> {page.label}</span></div><div className="topbar-actions"><span className="network-badge"><span className="status-dot"/>{config?.chainName || 'Connecting'}</span><button className="button wallet-button" onClick={openWallet} disabled={!config || auth.restoring}><Icon name="wallet"/>{current ? shortAddress(current.wallet) : auth.restoring ? 'Restoring session' : 'Connect wallet'}</button></div></header>
      <main id="main-content" className="main-content" tabIndex={-1}>
        <div className="page-heading"><div><span className="eyebrow">{route === 'releases' ? 'YOUR CREATIVE WORKSPACE' : 'NFT CONSOLE'}</span><h1 ref={heading} tabIndex={-1}>{route === 'releases' ? 'Every collection starts here.' : page.label}</h1><p>{route === 'releases' ? 'One workspace. Independent collections. Deliberate releases.' : route === 'create' ? 'Give your next release a considered beginning.' : route === 'readiness' ? 'A clear view of what is verified, and what is still needed.' : route === 'transactions' ? 'Review wallet requests, recover interruptions and verify recorded receipts.' : route === 'launch' ? 'Publish selected works, review total cost, deploy or reuse a collection and mint through your wallet.' : route === 'private' ? 'End-to-end encrypted drafts, media and rights. Only ciphertext leaves this browser.' : route === 'collections' ? 'Live on-chain inventory, immutable settings and transfer policy.' : route === 'marketplace' ? 'Sign, submit and independently verify Seaport listings.' : route === 'help' ? 'Practical guidance for every step.' : 'Network, access and the boundaries of this build.'}</p></div>{route === 'releases' && <a href="#/create" className="button primary"><Icon name="plus"/>Create release</a>}</div>
        {configError && <Notice error>{configError} <button className="text-button" onClick={() => setConfigVersion(v => v + 1)}>Retry configuration</button></Notice>}
        {auth.error && !walletOpen && <Notice error>{auth.error} {auth.retryLogout && <button className="text-button" onClick={() => void auth.logout()}>Retry sign-out</button>}</Notice>}
        {!config && !configError && <p className="loading" role="status">Connecting to the console...</p>}
        {config && <>
          {route === 'releases' && <><div className="environment-note"><Icon name="info"/><p><strong>{config.production ? 'Production network — real fees.' : 'Rehearsal network.'}</strong> Draft privately, validate, publish deliberately, deploy and mint through your wallet, then list with independent verification. Nothing advances without on-chain or byte-level evidence.</p><a href="#/help">How it works <Icon name="arrow"/></a></div>
            <div className="overview-cards"><article><Icon name="wallet"/><span>Wallet access</span><strong>{current ? 'Signed in' : 'Not connected'}</strong><small>{current ? `${current.role} access` : 'No signature requested yet'}</small></article><article><Icon name="lock"/><span>Private workspace</span><strong>{config.capabilities.privateWorkspace ? 'End-to-end encrypted' : 'Database required'}</strong><small>Client-side encryption; server holds ciphertext</small></article><article><Icon name="layers"/><span>Marketplace</span><strong>{config.capabilities.list ? `Listing via ${config.capabilities.marketplace}` : 'Listing not configured'}</strong><small>Listed only after independent verification</small></article></div>
            <Dashboard current={current} config={config}/>
            <ReleaseInventory current={current} config={config} connect={openWallet} expired={auth.expire}/></>}
          {route === 'create' && <CollectionPlanner current={current} config={config} connect={openWallet}/>}
          {route === 'readiness' && <ReleaseReadiness current={current} connect={openWallet} expired={auth.expire}/>}
          {route === 'launch' && <Suspense fallback={<p role="status">Loading mint tools...</p>}><PublicLaunch current={current} config={config} connect={openWallet} expired={auth.expire} walletProvider={auth.walletProvider}/></Suspense>}
          {route === 'transactions' && <Suspense fallback={<p role="status">Loading transaction tools...</p>}><MintTransactions current={current} config={config} connect={openWallet} expired={auth.expire} walletProvider={auth.walletProvider}/></Suspense>}
          {route === 'settings' && <Settings config={config} current={current}/>}
          {route === 'private' && <Suspense fallback={<p role="status">Loading private workspace...</p>}><PrivateStudio current={current} config={config} connect={openWallet} expired={auth.expire}/></Suspense>}
          {route === 'collections' && <Suspense fallback={<p role="status">Loading collections...</p>}><Collections current={current} config={config} connect={openWallet} expired={auth.expire} walletProvider={auth.walletProvider}/></Suspense>}
          {route === 'marketplace' && <Suspense fallback={<p role="status">Loading marketplace...</p>}><Marketplace current={current} config={config} connect={openWallet} expired={auth.expire} walletProvider={auth.walletProvider}/></Suspense>}
          {route === 'help' && <Help/>}
        </>}
      </main><footer className="workspace-footer"><span>NFT Console <span className="footer-divider">/</span> Independent collections. Explicit decisions.</span><span>No signing keys stored.</span></footer>
    </div>
    {menuOpen && <Modal title="Workspace navigation" close={() => setMenuOpen(false)}><Navigation route={route} close={() => setMenuOpen(false)}/></Modal>}
    {walletOpen && <Modal title={current ? 'Your connected wallet' : 'Connect your wallet'} close={() => { if (auth.phase) auth.cancel(); setWalletOpen(false); }}>
      {current ? <><p className="address-full mono">{current.wallet}</p><span className="badge">{current.role} access</span><p>You are signed in. This does not authorize transactions or marketplace orders.</p><button className="button secondary full-width" onClick={() => { void auth.logout(); setWalletOpen(false); }}>Sign out</button></> : <>
        <p className="modal-intro">Choose a wallet, then review the sign-in message. Your private keys never leave your wallet.</p>
        {!config?.loginConfigured ? <Notice>Administrator setup is required before wallet sign-in can work. Check the workspace settings.</Notice> : wallets.length === 0 ? <Notice>No wallet was detected. Open the console in a wallet-enabled browser, then reload this page.</Notice> : <div className="wallet-choices">{wallets.map(choice => <button key={choice.id} className="wallet-choice" disabled={Boolean(auth.phase) || auth.retryLogout || auth.restoring} onClick={() => void auth.connect(choice)}><span className="wallet-initial" aria-hidden="true">{choice.name.slice(0,1).toUpperCase()}</span><span>{choice.name}</span><Icon name="arrow"/></button>)}</div>}
        {auth.phase && <div className="signing-status" role="status"><span className="spinner"/>{auth.phase}<button className="text-button" onClick={auth.cancel}>Cancel sign-in</button></div>}
        {auth.error && <Notice error>{auth.error} {auth.retryLogout && <button className="text-button" onClick={() => void auth.logout()}>Retry sign-out</button>}</Notice>}
        <div className="wallet-disclosure"><Icon name="check"/><p>This signature only signs you in. It does not approve transfers, mint NFTs or list anything for sale.</p></div><p className="fine-print">Safe accounts need a compatible provider and the required owner signatures. Signing as one Safe owner is not Safe authorization.</p>
      </>}
    </Modal>}
  </div>;
}
