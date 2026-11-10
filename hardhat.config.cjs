require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
// Offline/air-gapped builds: point HARDHAT_SOLC_PATH at a locally verified solc 0.8.24 static binary
// (sha256 fb03a29a517452b9f12bcf459ef37d0a543765bb3bbc911e70a87d6a37c30d5f for solc-static-linux v0.8.24).
if (process.env.HARDHAT_SOLC_PATH) {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, _hre, runSuper) => {
    if (args.solcVersion !== "0.8.24") return runSuper();
    return { compilerPath: process.env.HARDHAT_SOLC_PATH, isSolcJs: false, version: "0.8.24", longVersion: "0.8.24+commit.e11b9ed9" };
  });
}
module.exports = { solidity: { version:"0.8.24", settings:{optimizer:{enabled:true,runs:200}} }, networks:{hardhat:{hardfork:"cancun",allowUnlimitedContractSize:true}} };
