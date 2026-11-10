// Compiles the pinned Limit Break creator-token-transfer-validator checkout with solc 0.8.24
// (standard JSON, no network) for disposable local policy tests. Output: artifacts-validator/*.json
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import path from 'node:path';
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const vendor=path.join(root,'vendor/creator-token-transfer-validator');
const COMMIT='59adb8b36ab0256c7430b017b1c9f8b4841d6e1e';
const head=execFileSync('git',['-C',vendor,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(head!==COMMIT)throw new Error('Validator checkout must be the pinned commit '+COMMIT);
const solc=process.env.HARDHAT_SOLC_PATH||'solc';
const remap={'@limitbreak/tm-core-lib/':'lib/tm-core-lib/','@limitbreak/permit-c/':'lib/PermitC/src/','@openzeppelin/':'lib/PermitC/lib/openzeppelin-contracts/'};
const targets=['src/CreatorTokenTransferValidator.sol','src/modules/ModuleCollectionAndListManagement.sol','src/modules/ModuleRulesetBindings.sol','src/rulesets/RulesetWhitelist.sol','src/rulesets/RulesetVanilla.sol','src/rulesets/RulesetBlacklist.sol','src/rulesets/RulesetSoulbound.sol'];
const missing=targets.filter(t=>!existsSync(path.join(vendor,t)));if(missing.length)throw new Error('Missing '+missing.join(','));
const input={language:'Solidity',sources:Object.fromEntries(targets.map(t=>[t,{urls:[t]}])),settings:{optimizer:{enabled:true,runs:1000000},evmVersion:'cancun',metadata:{appendCBOR:false},remappings:Object.entries(remap).map(([a,b])=>`${a}=${b}`),outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
const out=JSON.parse(execFileSync(solc,['--standard-json','--base-path',vendor,'--allow-paths',vendor],{cwd:vendor,input:JSON.stringify(input),maxBuffer:1<<28}).toString());
const errors=(out.errors||[]).filter(e=>e.severity==='error');if(errors.length)throw new Error(errors.map(e=>e.formattedMessage).join('\n'));
mkdirSync(path.join(root,'artifacts-validator'),{recursive:true});
for(const t of targets){const name=path.basename(t,'.sol'),c=out.contracts[t][name];writeFileSync(path.join(root,'artifacts-validator',name+'.json'),JSON.stringify({contractName:name,source:t,commit:COMMIT,abi:c.abi,bytecode:'0x'+c.evm.bytecode.object}));}
const eoa=/canonicalEOARegistry, hex"([0-9a-f]+)"/.exec(readFileSync(path.join(vendor,'test/EOARegistry.t.sol'),'utf8'));if(!eoa)throw new Error('Pinned EOA registry runtime not found');
writeFileSync(path.join(root,'artifacts-validator','EOARegistryRuntime.json'),JSON.stringify({address:'0xE0A0004Dfa318fc38298aE81a666710eaDCEba5C',commit:COMMIT,runtime:'0x'+eoa[1]}));
console.log('Compiled',targets.length,'validator contracts at',COMMIT);
