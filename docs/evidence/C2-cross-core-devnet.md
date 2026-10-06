# Devnet end-to-end — cross_core (C2)

Run: 2026-10-06T03:08:23.609Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/core-e2e.ts` (drives `@opening-cross/sdk`)
Program: cross_core `F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ`

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| protocol | protocol already initialised at the current layout | PASS | — | protocol 9PMi5EbYJ9YfpVcDgBUKfkTJeegcSWGEMMtXiRUgHx6G |
| launch-create | mint-mode launch cross created; cross PDA holds the base mint authority | PASS | [5oJKphQw…](https://explorer.solana.com/tx/5oJKphQwixjNP81rJu6vvh3T22mjqek913e2X5k4fiRA27KJGxobijFQuf3Sjjwn25iKqjKE2zFfEPMGt5TcdQre?cluster=devnet) | cross DCE38rv4jem4NeBsXoUJVvnNUSe6AdGELFHNMQVgo6og, base 5Gt8JhbkEL7Pm7C79NhpA5EHSfWqEsGG3knnjS98M1tb, quote AnJtMhjHVHZPhTNxP5VDTT6MVNdXbdq5a5mZbCiojNu4 |
| launch-bid-0 | bid 1500000000 at 1500000 escrowed | PASS | [4s8L3ceB…](https://explorer.solana.com/tx/4s8L3ceBajTwdk7DBGJLg9jKRhjx8eQH8jj9NDQqMeCJV1YN4x6eGjKbo4F7dvTRzz2mtYa6q2uDCFiNDDqwmghz?cluster=devnet) | buyer CHqha2DdGt15XdwfMM9ksx1RLXERc9GNUAecD34oqdNk |
| launch-bid-1 | bid 800000000 at 1200000 escrowed | PASS | [4Uxg4DA5…](https://explorer.solana.com/tx/4Uxg4DA51GmgQvRxLRFWJju2La1YtQ5D72RbuCXSvUM2UQFtXxvdMbjtArhiHq7bXgDHKnEAE32FM5SoJe9RsZif?cluster=devnet) | buyer 6JskcYHF19bAvpsN3acbBhP3VEKH7P1ELKFfukiVqku9 |
| launch-bid-2 | bid 500000000 at 1100000 escrowed | PASS | [5KeTCiFA…](https://explorer.solana.com/tx/5KeTCiFAZuRHxNQgSRQQNaL8znkiLbDNcVfjnqkPr2N5LLjkXQWVnX6VheGxGT864XyoziLa7xTtmyUADtK87jb7?cluster=devnet) | buyer s4LQSHTCKFGZaubYUXNutMqMw2w9mHm7dLYkUXPQYcn |
| launch-clear | on-chain clearing price and volume equal the independent reference | PASS | [2mYKro3v…](https://explorer.solana.com/tx/2mYKro3vpCJ9Btpmy1FJHbv7BaXjnjmJq4b6Asy7o4NmEHSiCQ3k7t1SYcphta8d274QLHB6RSoZe4fLAgXt8VHv?cluster=devnet) | P* 1200000 (ref 1200000), matched 2000000000 (ref 2000000000) |
| launch-claim-0 | claim minted the fill and refunded escrow above P* | PASS | [piwYkpCJ…](https://explorer.solana.com/tx/piwYkpCJeye7VXGWrpsXvYCB5xphpxtURvWHoG97msxEDtte74eWe2i1wB81DegCxW9zbHLiVKRNQZzUq48GFNd?cluster=devnet) | fill 1500000000 (ref 1500000000), refund 450000000 (expected 450000000) |
| launch-claim-1 | claim minted the fill and refunded escrow above P* | PASS | [kSCK3rLL…](https://explorer.solana.com/tx/kSCK3rLLU5HoSFoeDUbTTqjpWSh5y8muRBB5hbbj8NuyVrHojtj4gsWmvoMJUB6ZsrJKpNxB7wx6V3Y45QbCSkJ?cluster=devnet) | fill 500000000 (ref 500000000), refund 360000000 (expected 360000000) |
| launch-claim-2 | claim minted the fill and refunded escrow above P* | PASS | [adk42CgF…](https://explorer.solana.com/tx/adk42CgFum9GoqkodzPYWnHNhqNPhSu58PpqWKaAudfF2MnqivR1s1WqxQs76JYWkGzYD8oY8xBGfkXj9XsNBLj?cluster=devnet) | fill 0 (ref 0), refund 550000000 (expected 550000000) |
| launch-finalize | finalize: fees and proceeds paid, quote vault empty, mint authority revoked | PASS | [3J7wR9hv…](https://explorer.solana.com/tx/3J7wR9hv3hsWCgFH7BFSqLMXL3JTQZ2sv9UWus4J2rF5rFSzbwm8N182sibVDAAXXPSmPYtjnSXNtw6wjJs6hvLo?cluster=devnet) | mintAuthority None, quote vault 0 |
| sealed-create | sealed escrow-mode cross created | PASS | [4n4wbT7n…](https://explorer.solana.com/tx/4n4wbT7nLoFwKzuCBdT4JoJENxzBREmXmio2bne8GveRQZQJoJtsU25Hrecy5s9SuVZRRhBW5TbpbQAUtCK1UCbL?cluster=devnet) | cross 2gS3tViAZu8se7AwBBBdSy6ty6517m7cCZg5ncbT1ReZ |
| sealed-hidden | during the call only a commitment is on chain (price and quantity are zero) | PASS | — | order HfukHkhFfk7H1dZgFBCMsR8eTWDfKyVdSektkTv85P5T escrow 152000000 |
| sealed-clear | sealed cross clears to the reference (reference price rule applied); unrevealed order excluded | PASS | [5nKUmeFj…](https://explorer.solana.com/tx/5nKUmeFjibfncwPrHFeHELedm6NfG5Np2bCody3sC84fTq9LWyA3LCXw8b4pQmAHGkQF3Y8N618UcXMSXwLn8PWR?cluster=devnet) | P* 1300000 (ref 1300000), matched 80000000 |
| sealed-refund | the order that never revealed is refunded in full | PASS | — | refund 95000000 |
| sealed-finalize | sealed cross finalised | PASS | [5mGVjPnB…](https://explorer.solana.com/tx/5mGVjPnBV6JrnHc37eN4CDfe1pxXrkQMr3JarXNBRYWzGWBVy5EsXPz6BFoZ6PvXnzqm4W1Dp4rALxZTnN94C5pf?cluster=devnet) | state Finalized |
