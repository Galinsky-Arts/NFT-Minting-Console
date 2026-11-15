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
const PublicLaunch = lazy(() => import('./PublicLaunch').then(module => ({default: module.PublicLaunch})));
const MintTransactions = lazy(() => import('./MintTransactions').then(module => ({ default: module.MintTransactions })));
const PrivateWorkspaceView = lazy(() => import('./PrivateWorkspaceView').then(module => ({ default: module.PrivateWorkspaceView })));
const Marketplace = lazy(() => import('./Marketplace').then(module => ({ default: module.Marketplace })));

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
    <aside className="sidebar"><a href="#/releases" className="brand"><span className="brand-mark">N</span><span>NFT<span className="brand-light"> CONSOLE</span></span></a><span className="sidebar-label">CREATOR WORKSPACE</span><Navigation route={route}/><div className="sidebar-bottom"><Icon name="lock"/><strong>Your keys stay in your wallet.</strong><p>Sign in to manage your releases.<br/>Never share a private key.</p><span className="sidebar-build">DEVELOPMENT BUILD</span></div></aside>
    <div className="workspace"><header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Icon name="menu"/></button><span className="breadcrumb">Workspace <span>/</span> {page.label}</span></div><div className="topbar-actions"><span className="network-badge"><span className="status-dot"/>{config?.chainName || 'Connecting'}</span><button className="button wallet-button" onClick={openWallet} disabled={!config || auth.restoring}><Icon name="wallet"/>{current ? shortAddress(current.wallet) : auth.restoring ? 'Restoring session' : 'Connect wallet'}</button></div></header>
      <main id="main-content" className="main-content" tabIndex={-1}>
        <div className="page-heading"><div><span className="eyebrow">{route === 'releases' ? 'YOUR CREATIVE WORKSPACE' : 'NFT CONSOLE'}</span><h1 ref={heading} tabIndex={-1}>{route === 'releases' ? 'Every collection starts here.' : page.label}</h1><p>{route === 'releases' ? 'One workspace. Independent collections. Deliberate releases.' : route === 'create' ? 'Give your next release a considered beginning.' : route === 'readiness' ? 'A clear view of what is verified, and what is still needed.' : route === 'transactions' ? 'Review wallet requests, recover interruptions and verify recorded receipts.' : route === 'launch' ? 'Deploy a collection and mint finalized public NFTs through your wallet.' : route === 'workspace' ? 'Encrypted drafts, private files and your authorized devices.' : route === 'marketplace' ? 'List minted NFTs, verify active orders and track sales and royalties.' : 'Network, access and the boundaries of this build.'}</p></div>{route === 'releases' && <a href="#/create" className="button primary"><Icon name="plus"/>Create release</a>}</div>
        {configError && <Notice error>{configError} <button className="text-button" onClick={() => setConfigVersion(v => v + 1)}>Retry configuration</button></Notice>}
        {auth.error && !walletOpen && <Notice error>{auth.error} {auth.retryLogout && <button className="text-button" onClick={() => void auth.logout()}>Retry sign-out</button>}</Notice>}
        {!config && !configError && <p className="loading" role="status">Connecting to the console...</p>}
        {config && <>
          {route === 'releases' && <><div className="environment-note"><Icon name="info"/><p><strong>Development workspace.</strong> Wallet sign-in and release records are available when configured. Use Deploy &amp; mint for finalized public releases when launch setup is configured. Prepare releases privately in the Private workspace and list minted NFTs from Marketplace.</p><a href="#/readiness">View release gates <Icon name="arrow"/></a></div>
            <div className="overview-cards"><article><Icon name="wallet"/><span>Wallet access</span><strong>{current ? 'Signed in' : 'Not connected'}</strong><small>{current ? `${current.role} access` : 'No signature requested yet'}</small></article><article><Icon name="lock"/><span>Private workspace</span><strong>End-to-end encrypted</strong><small><a href="#/workspace">Open private workspace</a></small></article><article><Icon name="layers"/><span>Public minting</span><strong>{config.capabilities.publicLaunch ? 'Configured' : 'Launch setup required'}</strong><small>No active orders verified</small></article></div>
            <ReleaseInventory current={current} config={config} connect={openWallet} expired={auth.expire}/></>}
          {route === 'create' && <CollectionPlanner current={current} config={config} connect={openWallet}/>}
          {route === 'readiness' && <ReleaseReadiness current={current} connect={openWallet} expired={auth.expire}/>}
          {route === 'launch' && <Suspense fallback={<p role="status">Loading mint tools...</p>}><PublicLaunch current={current} config={config} connect={openWallet} expired={auth.expire} walletProvider={auth.walletProvider}/></Suspense>}
          {route === 'transactions' && <Suspense fallback={<p role="status">Loading transaction tools...</p>}><MintTransactions current={current} config={config} connect={openWallet} expired={auth.expire} walletProvider={auth.walletProvider}/></Suspense>}
          {route === 'workspace' && <Suspense fallback={<p role="status">Loading private workspace...</p>}><PrivateWorkspaceView current={current} connect={openWallet} expired={auth.expire}/></Suspense>}
          {route === 'marketplace' && <Suspense fallback={<p role="status">Loading marketplace tools...</p>}><Marketplace current={current} config={config} connect={openWallet} expired={auth.expire} walletProvider={auth.walletProvider}/></Suspense>}
          {route === 'settings' && <Settings config={config} current={current}/>}
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
