import { getAddress, isAddress } from 'ethers/address';
export interface DraftFile { role: 'primary' | 'companion'; name: string; type: string; size: number; sha256: string; blobId: string; manifest: Record<string, unknown>; complete: boolean; publicSelected?: boolean }
export interface Rights { text: string; approvedSha256: string | null; approvedAt: string | null }
export interface DraftWork { id: string; tokenId: string; title: string; description: string; editionNumber: string; editionOf: string; rightsMode: 'collection' | 'token'; rights: Rights; files: DraftFile[]; publicSelected: boolean }
export interface ReleaseDraft { version: 1; name: string; symbol: string; supply: string; royaltyPercent: string; owner: string; minter: string; royaltyRecipient: string; chainId: number; description: string; listingPriceEth: string; collectionRights: Rights; works: DraftWork[]; deployedCollection: string; originalPurchaserBenefits: string; validation: { digest: string; at: string; errors: number } | null; lifecycle: string }
export interface Finding { level: 'error' | 'warning' | 'info'; field: string; message: string; fix: string }
export const MEDIA_RULES: Record<string, { types: RegExp; max: number }> = { primary: { types: /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm)|audio\/(mpeg|mp4|wav|x-wav|webm))$/, max: 2 * 1024 ** 3 }, companion: { types: /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm)|audio\/(mpeg|mp4|wav|x-wav|webm)|application\/pdf|text\/(plain|markdown))$/, max: 2 * 1024 ** 3 } };
export const emptyRights = (): Rights => ({ text: '', approvedSha256: null, approvedAt: null });
export function newDraft(chainId: number): ReleaseDraft { return { version: 1, name: '', symbol: '', supply: '', royaltyPercent: '', owner: '', minter: '', royaltyRecipient: '', chainId, description: '', listingPriceEth: '', collectionRights: emptyRights(), works: [], deployedCollection: '', originalPurchaserBenefits: '', validation: null, lifecycle: 'draft' }; }
export function newWork(): DraftWork { return { id: crypto.randomUUID(), tokenId: '', title: '', description: '', editionNumber: '', editionOf: '', rightsMode: 'collection', rights: emptyRights(), files: [], publicSelected: false }; }
export async function sha256Text(text: string) { const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); return Array.from(h, b => b.toString(16).padStart(2, '0')).join(''); }
/** Canonical digest of everything that validation covers; any edit changes it and invalidates the result. */
export async function draftDigest(d: ReleaseDraft) { const { validation: _v, lifecycle: _l, ...rest } = d; void _v; void _l; return sha256Text(JSON.stringify(rest, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v))); }
const addr = (v: string) => isAddress(v) && !/^0x0{40}$/i.test(v);
const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
/** Examines the actual current draft. Rights approval is checked against the exact current bytes. */
export async function validateRelease(d: ReleaseDraft, ctx: { chainId: number }): Promise<Finding[]> {
  const f: Finding[] = [], err = (field: string, message: string, fix: string) => f.push({ level: 'error', field, message, fix }), warn = (field: string, message: string, fix: string) => f.push({ level: 'warning', field, message, fix }), info = (field: string, message: string, fix = '') => f.push({ level: 'info', field, message, fix });
  if (!d.name.trim() || d.name.length > 100) err('name', 'Collection name is required (up to 100 characters).', 'Enter the collection name.');
  if (!/^[A-Za-z0-9]{1,11}$/.test(d.symbol)) err('symbol', 'Symbol must be 1–11 letters or digits.', 'Enter a short ticker such as ART.');
  const supply = /^[1-9]\d{0,5}$/.test(d.supply) ? Number(d.supply) : 0; if (!supply) err('supply', 'Maximum supply must be a whole number from 1 to 999999. It is immutable after deployment.', 'Enter the maximum number of tokens.');
  const royalty = /^\d{1,3}(\.\d{1,2})?$/.test(d.royaltyPercent) ? Number(d.royaltyPercent) : NaN; if (!(royalty >= 0 && royalty <= 100)) err('royaltyPercent', 'Royalty must be 0–100% with at most two decimals. It is immutable after deployment.', 'Enter a royalty percentage, e.g. 5.');
  else if (royalty > 10) warn('royaltyPercent', `A ${royalty}% royalty is unusually high; marketplaces may cap or ignore it.`, 'Confirm the rate is intended.');
  for (const [k, label] of [['owner', 'Owner'], ['minter', 'Minter'], ['royaltyRecipient', 'Royalty recipient']] as const) if (!addr(d[k])) err(k, `${label} must be a valid, non-zero wallet address.`, `Paste the ${label.toLowerCase()} address.`);
  if (addr(d.owner) && addr(d.minter) && getAddress(d.owner) === getAddress(d.minter)) info('roles', 'Owner and minter are the same wallet. This is allowed; they remain separate immutable fields.');
  if (d.chainId !== ctx.chainId) err('chainId', `This draft targets chain ${d.chainId}, but the console runs on chain ${ctx.chainId}.`, 'Create the release on the matching network.');
  if (d.deployedCollection && !addr(d.deployedCollection)) err('deployedCollection', 'Recorded collection address is invalid.', 'Clear or correct it.');
  if (supply && d.works.length > supply) err('works', `There are ${d.works.length} works but supply is ${supply}.`, 'Remove works or raise supply before deployment.');
  if (!d.works.length) err('works', 'Add at least one work.', 'Use “Add work”.');
  const ids = new Map<string, number>();
  for (const [i, w] of d.works.entries()) {
    const at = `works.${i}`, n = /^[1-9]\d{0,5}$/.test(w.tokenId) ? Number(w.tokenId) : 0;
    if (!n || (supply && n > supply)) err(at + '.tokenId', `Work ${i + 1}: token ID must be between 1 and the maximum supply.`, 'Assign a unique token ID.');
    ids.set(w.tokenId, (ids.get(w.tokenId) || 0) + 1);
    if (!w.title.trim() || w.title.length > 200) err(at + '.title', `Work ${i + 1}: title is required (up to 200 characters).`, 'Enter the work title.');
    if (w.editionNumber || w.editionOf) { const a = Number(w.editionNumber), b = Number(w.editionOf); if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 1 && a <= b)) err(at + '.edition', `Work ${i + 1}: edition must read “n of m” with 1 ≤ n ≤ m.`, 'Fix the edition numbers.'); }
    const primary = w.files.filter(x => x.role === 'primary');
    if (primary.length !== 1) err(at + '.files', `Work ${i + 1}: exactly one primary artwork file is required.`, 'Attach the primary artwork.');
    for (const file of w.files) {
      const rule = MEDIA_RULES[file.role]!;
      if (!rule.types.test(file.type)) err(at + '.files', `Work ${i + 1}: ${file.name} (${file.type || 'unknown type'}) is not an accepted ${file.role} format.`, 'Use PNG, JPEG, WebP, GIF, MP4, WebM, MP3, M4A, WAV (and PDF/text for companions).');
      if (file.size > rule.max) err(at + '.files', `Work ${i + 1}: ${file.name} exceeds the 2 GiB limit.`, 'Use a smaller file.');
      if (!file.complete) err(at + '.files', `Work ${i + 1}: ${file.name} has not finished its encrypted upload.`, 'Resume the upload by selecting the same file again.');
    }
    const rights = w.rightsMode === 'token' ? w.rights : d.collectionRights;
    if (!rights.text.trim()) err(at + '.rights', `Work ${i + 1}: no rights terms are attached.`, w.rightsMode === 'token' ? 'Write the token-specific terms.' : 'Write the collection rights terms.');
    else if (!rights.approvedSha256) err(at + '.rights', `Work ${i + 1}: rights terms have not been approved.`, 'Review and approve the exact final terms.');
    else if (rights.approvedSha256 !== await sha256Text(rights.text)) err(at + '.rights', `Work ${i + 1}: the rights text changed after approval; the approved hash is stale.`, 'Re-approve the revised terms.');
    if (email.test(w.description) || email.test(w.title)) warn(at + '.description', `Work ${i + 1}: the public description appears to contain an email address.`, 'Keep personal contact details out of public metadata.');
  }
  for (const [id, count] of ids) if (id && count > 1) err('works', `Token ID ${id} is assigned to ${count} works.`, 'Give every work a unique token ID.');
  if (email.test(d.description)) warn('description', 'The collection description appears to contain an email address.', 'Remove personal data from public text.');
  if (d.originalPurchaserBenefits.trim()) info('benefits', 'Original-purchaser benefits are recorded privately and are not placed in public metadata. They do not transfer with the NFT unless your terms say so.');
  if (/invest|profit|return on|appreciat|dividend/i.test(d.collectionRights.text + d.works.map(w => w.rights.text).join(' ') + d.description)) warn('rights', 'The text mentions investment, profit or appreciation. NFT Console does not provide securities or investment terms.', 'Have the offering reviewed; remove financial-return language unless legally approved.');
  info('royalty', 'ERC-2981 royalty information is published on-chain, but payment depends on the sale path and marketplace.');
  return f;
}
export const lifecycleLabels: Record<string, string> = { draft: 'Draft', validated: 'Validated', published: 'Published', deployed: 'Deployed', policy: 'Policy configured', minting: 'Minting', listed: 'Listed', archived: 'Archived' };
