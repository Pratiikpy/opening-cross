// A Wallet Standard wallet for end-to-end tests, injected into the page by Playwright before any
// app code runs (it is not part of the app bundle). It registers through the same protocol real
// wallets use, shows up in the app's wallet list, and signs transactions with a disposable
// localnet keypair through WebCrypto Ed25519. Every signature is a real one the cluster verifies.
// The keypair arrives as window.__E2E_WALLET__ = { name, secret: number[64], chain }.
(() => {
  const cfg = window.__E2E_WALLET__;
  if (!cfg) return;
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = (bytes) => {
    let n = 0n;
    for (const b of bytes) n = n * 256n + BigInt(b);
    let s = '';
    while (n > 0n) {
      s = ALPHABET[Number(n % 58n)] + s;
      n /= 58n;
    }
    for (const b of bytes) {
      if (b !== 0) break;
      s = '1' + s;
    }
    return s;
  };
  const secret = Uint8Array.from(cfg.secret);
  const publicKey = secret.slice(32);
  const address = b58(publicKey);
  const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...secret.slice(0, 32)]);
  const keyPromise = crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);

  // Wire format: shortvec(signature count) ‖ signatures (64 bytes each) ‖ message. The message's
  // static account keys start after the header; signer i signs into slot i.
  const shortvec = (bytes, at) => {
    let len = 0;
    let size = 0;
    for (;;) {
      const b = bytes[at + size];
      len |= (b & 0x7f) << (7 * size);
      size += 1;
      if ((b & 0x80) === 0) return [len, size];
    }
  };
  async function sign(wire) {
    const [count, n] = shortvec(wire, 0);
    const msgStart = n + 64 * count;
    const message = wire.slice(msgStart);
    const versioned = (message[0] & 0x80) !== 0;
    const header = versioned ? 1 : 0;
    const [keys, kn] = shortvec(message, header + 3);
    const keysStart = header + 3 + kn;
    let slot = -1;
    for (let i = 0; i < Math.min(keys, count); i++) {
      const k = message.slice(keysStart + 32 * i, keysStart + 32 * (i + 1));
      if (k.every((x, j) => x === publicKey[j])) slot = i;
    }
    if (slot < 0) throw new Error('This transaction does not need a signature from this wallet.');
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, await keyPromise, message));
    const out = wire.slice();
    out.set(sig, n + 64 * slot);
    window.__E2E_SIGNED__ = (window.__E2E_SIGNED__ || 0) + 1;
    return out;
  }

  const account = Object.freeze({ address, publicKey, chains: [cfg.chain], features: ['solana:signTransaction'], label: cfg.name });
  let connected = [];
  const listeners = new Set();
  const wallet = {
    version: '1.0.0',
    name: cfg.name,
    icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#0b0b0f"/><text x="12" y="16" font-size="10" text-anchor="middle" fill="#fff" font-family="monospace">E2E</text></svg>'),
    chains: [cfg.chain],
    get accounts() {
      return connected;
    },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async (input) => {
          // Like real wallets: a silent connect succeeds only for a site approved before.
          const approved = localStorage.getItem('__e2e_wallet_approved__') === address;
          if (input && input.silent && !approved) return { accounts: [] };
          localStorage.setItem('__e2e_wallet_approved__', address);
          connected = [account];
          for (const l of listeners) l({ accounts: connected });
          return { accounts: connected };
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          localStorage.removeItem('__e2e_wallet_approved__');
          connected = [];
          for (const l of listeners) l({ accounts: connected });
        },
      },
      'standard:events': {
        version: '1.0.0',
        on: (event, listener) => {
          if (event !== 'change') return () => {};
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs) => {
          if (window.__E2E_REJECT_NEXT__) {
            window.__E2E_REJECT_NEXT__ = false;
            throw new Error('User rejected the request.');
          }
          return Promise.all(inputs.map(async (i) => ({ signedTransaction: await sign(i.transaction) })));
        },
      },
    },
  };
  const register = ({ register: r }) => r(wallet);
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
  } catch (e) {
    console.error('test wallet registration failed', e);
  }
  window.addEventListener('wallet-standard:app-ready', ({ detail }) => register(detail));
})();
