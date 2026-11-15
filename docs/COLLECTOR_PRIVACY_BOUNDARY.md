# NFT-14: public collector receipt minimization increment

The client-only console/privacy/collector.mjs function rejects any object carrying
own fields beyond chainId, contract, tokenId and transactionHash, including
non-enumerable and symbol-keyed fields. It rejects inherited
prototypes, accessor properties, invalid identifiers and out-of-range uint256 token
IDs. The returned chain receipt is immutable. No storage, collector registration,
network, analytics, personal contacts or consent is implemented or enabled.

Public chain identifiers can still be personal information in context and public
blockchain history cannot be erased. This does not establish legal compliance.

Test: node --test test-rights/collector-privacy.test.mjs

Remaining NFT-14: authorized private personal-data lifecycle, lawful basis/notice,
retention, request/export/deletion process, data-subject authentication, actual
UI/service integration, privacy testing and legal decisions. Full acceptance pending.
