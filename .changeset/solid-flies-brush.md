---
"@walletconnect/solana-adapter": patch
"playground": patch
---

Fixes issue where adapter would not properly handle closing the modal without connecting, causing `isConnected` to never be reset and the modal to not re-open
