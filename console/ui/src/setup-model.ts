import {getAddress} from 'ethers/address';
import {setupMessage} from '../../setup/message.mjs';
export interface SetupStatus {version:1;required:boolean;chainId:number;chainName:string;databaseVerified:boolean;codeConfigured:boolean;runtimeReady:boolean;fullProductReady:false;chainConfigured?:boolean}
export interface SetupChallenge {version:1;challengeId:string;message:string;issuedAt:string;expiresAt:string}
export function readSetupStatus(input:unknown):SetupStatus {
  const v=input as Partial<SetupStatus>|null;
  if(!v||v.version!==1||typeof v.required!=='boolean'||![1,11155111,31337].includes(v.chainId as number)||typeof v.chainName!=='string'||v.chainName.length>80||v.databaseVerified!==true||typeof v.codeConfigured!=='boolean'||typeof v.runtimeReady!=='boolean'||v.fullProductReady!==false||(v.chainConfigured!==undefined&&typeof v.chainConfigured!=='boolean'))throw new Error('The installation status could not be verified.');
  return v as SetupStatus;
}
export function readSetupChallenge(input:unknown,expected:{origin:string;wallet:string;chainId:number},now=Date.now()):SetupChallenge {
  const v=input as Partial<SetupChallenge>|null;
  if(!v||v.version!==1||typeof v.challengeId!=='string'||!/^[a-f0-9]{64}$/.test(v.challengeId)||typeof v.message!=='string'||v.message.length>4096||typeof v.issuedAt!=='string'||typeof v.expiresAt!=='string')throw new Error('The administrator registration request was invalid.');
  const issued=Date.parse(v.issuedAt),expires=Date.parse(v.expiresAt);
  if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now+30000||expires<=now||expires-issued!==300000||v.message!==setupMessage({origin:expected.origin,wallet:getAddress(expected.wallet),chainId:expected.chainId,nonce:v.challengeId,issuedAt:v.issuedAt,expiresAt:v.expiresAt}))throw new Error('The administrator registration request changed, expired or targets another installation.');
  return v as SetupChallenge;
}
