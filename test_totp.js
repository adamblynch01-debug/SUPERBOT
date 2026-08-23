// Test TOTP generation with the provided secret
const crypto = require('crypto');

const totpSecret = '7Z7LWLD4SFFR2D2Q';

console.log('Testing TOTP secret:', totpSecret);
console.log('Length:', totpSecret.length);
console.log('Format check:', /^[A-Z2-7]+=*$/.test(totpSecret));

// Base32 decode
const base32Decode = (encoded) => {
  encoded = encoded.toUpperCase().replace(/=+$/, '');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';

  for (let i = 0; i < encoded.length; i++) {
    const val = alphabet.indexOf(encoded[i]);
    if (val === -1) {
      throw new Error(`Invalid base32 character at position ${i}: ${encoded[i]}`);
    }
    bits += val.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substr(i, 8), 2));
  }

  return Buffer.from(bytes);
};

try {
  const secret = base32Decode(totpSecret);
  console.log('Decoded secret (hex):', secret.toString('hex'));

  const period = 30;
  const timeCounter = Math.floor(Date.now() / 1000 / period);
  console.log('Time counter:', timeCounter);

  // Generate HMAC
  const buffer = Buffer.alloc(8);
  let tc = timeCounter;
  for (let i = 7; i >= 0; i--) {
    buffer[i] = tc & 0xff;
    tc = tc >> 8;
  }

  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(buffer);
  const hash = hmac.digest();

  const offset = hash[hash.length - 1] & 0xf;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  const code = (binary % Math.pow(10, 6)).toString().padStart(6, '0');
  const remaining = period - (Math.floor(Date.now() / 1000) % period);

  console.log('✅ Generated code:', code);
  console.log('Expires in:', remaining, 'seconds');
} catch (err) {
  console.error('❌ Error:', err.message);
  console.error('Stack:', err.stack);
}
