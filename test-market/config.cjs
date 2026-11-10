const base = require('../hardhat.config.cjs');
const path = require('node:path');
module.exports = {
  ...base,
  solidity: { version: '0.8.24', settings: { viaIR: true, evmVersion: 'cancun', optimizer: { enabled: true, runs: 4294967295 } } },
  paths: { root: path.resolve(__dirname, '..'), sources: './test-market/contracts', tests: './test-market', cache: './cache-market', artifacts: './artifacts-market' },
};
