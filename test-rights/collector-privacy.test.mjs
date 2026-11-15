import test from 'node:test';
import assert from 'node:assert/strict';
import { publicCollectorReceipt } from '../console/privacy/collector.mjs';
const receipt = () => ({ chainId: 1, contract: '0x' + 'ab'.repeat(20),
  tokenId: '7', transactionHash: '0x' + 'cd'.repeat(32) });
test('minimal immutable public chain receipt', () => {
  const result = publicCollectorReceipt(receipt());
  assert.deepEqual(Object.keys(result), ['chainId', 'contract', 'tokenId', 'transactionHash']);
  assert.equal(Object.isFrozen(result), true);
});
test('reject private contact, marketing, consent and unknown fields', () => {
  for (const extra of ['email','fullName','postalAddress','consent','notes'])
    assert.throws(() => publicCollectorReceipt({...receipt(), [extra]: 'secret'}));
});
test('reject hidden own fields as well as enumerable private fields', () => {
  const nonEnumerable = receipt();
  Object.defineProperty(nonEnumerable, 'email', { value: 'private@example.invalid' });
  assert.throws(() => publicCollectorReceipt(nonEnumerable), /Collector receipt rejected/);
  const symbolic = receipt();
  symbolic[Symbol('private-contact')] = 'private@example.invalid';
  assert.throws(() => publicCollectorReceipt(symbolic), /Collector receipt rejected/);
});
test('reject malformed or out-of-range public fields', () => {
  for (const patch of [{chainId:0},{tokenId:'01'},{tokenId:String(1n<<256n)},
    {tokenId:1},{contract:'broken'},{transactionHash:'broken'}])
    assert.throws(() => publicCollectorReceipt({...receipt(), ...patch}));
});
test('reject getter and prototype injection without executing accessors', () => {
  const input = receipt();
  Object.defineProperty(input,'tokenId',{enumerable:true,get(){throw Error('getter executed')}});
  assert.throws(() => publicCollectorReceipt(input), /Collector receipt rejected/);
  assert.throws(() => publicCollectorReceipt(Object.assign(Object.create({bad:1}), receipt())));
});
