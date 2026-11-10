/** In-memory handoff of decrypted, user-selected works from the private studio to the publication workbench.
 * Selecting works here never publishes; the workbench still requires explicit review and consent. */
export interface PublicationHandoff { tokenId: string; title: string; description: string; files: { image?: File; media?: File; rights?: File } }
let pending: PublicationHandoff[] = [];
export function setHandoff(items: PublicationHandoff[]) { pending = items.slice(0, 10); }
export function takeHandoff(): PublicationHandoff[] { const out = pending; pending = []; return out; }
export function peekHandoff(): readonly PublicationHandoff[] { return pending; }
