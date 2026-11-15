const fail = () => { throw new TypeError('Collector receipt rejected'); };
const validObject = obj => obj !== null && typeof obj === 'object' && Object.getPrototypeOf(obj) === Object.prototype;
const address = /^0x[0-9a-fA-F]{40}$/;
const hash = /^0x[0-9a-fA-F]{64}$/;
/** Only public chain identifiers may cross this boundary. No customer contact data. */
export function publicCollectorReceipt(input) {
  const keys = ['chainId', 'contract', 'tokenId', 'transactionHash'];
  if (!validObject(input) || Reflect.ownKeys(input).length !== keys.length ||
      keys.some(key => !Object.hasOwn(input, key) ||
        !Object.getOwnPropertyDescriptor(input, key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'))) fail();
  const { chainId, contract, tokenId, transactionHash } = input;
  if (!Number.isSafeInteger(chainId) || chainId <= 0 ||
      typeof contract !== 'string' || !address.test(contract) ||
      typeof transactionHash !== 'string' || !hash.test(transactionHash) ||
      typeof tokenId !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(tokenId) ||
      BigInt(tokenId) > (1n << 256n) - 1n) fail();
  return Object.freeze({ chainId, contract: contract.toLowerCase(), tokenId,
    transactionHash: transactionHash.toLowerCase() });
}
