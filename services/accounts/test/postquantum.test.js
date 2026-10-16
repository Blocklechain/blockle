// Post-quantum guard: the accounts service must use ONLY symmetric, PQ-resistant primitives
// (scrypt, HMAC, AES-256-GCM on the client, CSPRNG). There must be NO quantum-vulnerable
// asymmetric cryptography (RSA/EC/ECDSA/DH/X25519) anywhere in our own code — so there is
// nothing for Shor's algorithm to break at the application layer. (TLS transport and PayPal
// are external layers, out of this service's code; see docs/ACCOUNTS.md §Post-quantum.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

// Node crypto asymmetric APIs + algorithm names that would introduce a quantum-breakable primitive.
const FORBIDDEN = [
  /createSign\s*\(/, /createVerify\s*\(/, /generateKeyPair/, /createECDH\s*\(/,
  /createDiffieHellman/, /publicEncrypt\s*\(/, /privateDecrypt\s*\(/, /createPublicKey/,
  /createPrivateKey/, /\brsa\b/i, /\becdsa\b/i, /\bed25519\b/i, /\bx25519\b/i, /\bsecp256k1\b/i,
];

test('service code contains no quantum-vulnerable asymmetric crypto', () => {
  const offenders = [];
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
    // strip comments so documentation mentioning these words doesn't trip the guard
    const code = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const re of FORBIDDEN) {
      if (re.test(code)) offenders.push(`${f}: ${re}`);
    }
  }
  assert.deepEqual(offenders, [], `asymmetric crypto found (quantum-vulnerable): ${offenders.join(', ')}`);
});
