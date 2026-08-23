/**
 * TOTP 2FA Module - Generate 2FA codes for Microsoft accounts
 * Reads TOTP secrets from account files and generates time-based codes
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// TOTP implementation (no external dependencies)
// Based on RFC 6238 - TOTP: Time-Based One-Time Password Algorithm
class TOTP {
  constructor(secret) {
    this.secret = this.base32Decode(secret);
    this.period = 30; // 30 second window
    this.digits = 6;  // 6 digit codes
  }

  // Generate current code
  now() {
    const timeCounter = Math.floor(Date.now() / 1000 / this.period);
    return this.generate(timeCounter);
  }

  // Get remaining seconds until code expires
  remaining() {
    return this.period - (Math.floor(Date.now() / 1000) % this.period);
  }

  // Generate TOTP code for a specific time counter
  generate(counter) {
    const buffer = Buffer.alloc(8);
    for (let i = 7; i >= 0; i--) {
      buffer[i] = counter & 0xff;
      counter = counter >> 8;
    }

    const hmac = crypto.createHmac('sha1', this.secret);
    hmac.update(buffer);
    const hash = hmac.digest();

    const offset = hash[hash.length - 1] & 0xf;
    const binary =
      ((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff);

    const otp = binary % Math.pow(10, this.digits);
    return otp.toString().padStart(this.digits, '0');
  }

  // Base32 decoder
  base32Decode(encoded) {
    encoded = encoded.toUpperCase().replace(/=+$/, '');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';

    for (let i = 0; i < encoded.length; i++) {
      const val = alphabet.indexOf(encoded[i]);
      if (val === -1) throw new Error('Invalid base32 character');
      bits += val.toString(2).padStart(5, '0');
    }

    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.substr(i, 8), 2));
    }

    return Buffer.from(bytes);
  }
}

// Account storage
const accounts = new Map();

/**
 * Load accounts from file
 * Format: email|password|refresh_token|client_id|totp_secret
 */
function loadAccounts(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`[TOTP] Account file not found: ${filePath}`);
    return 0;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  let loaded = 0;

  for (const line of lines) {
    const parts = line.trim().split('|');
    if (parts.length >= 5) {
      const [email, password, refreshToken, clientId, totpSecret] = parts;

      if (totpSecret && totpSecret.length > 0) {
        accounts.set(email.toLowerCase(), {
          email,
          password,
          refreshToken,
          clientId,
          totpSecret
        });
        loaded++;
      }
    }
  }

  console.log(`[TOTP] Loaded ${loaded} accounts with 2FA from ${filePath}`);
  return loaded;
}

/**
 * Generate 2FA code for an email
 */
function generate2FA(email) {
  const account = accounts.get(email.toLowerCase());
  if (!account) {
    return { error: 'Account not found' };
  }

  if (!account.totpSecret) {
    return { error: 'No TOTP secret for this account' };
  }

  try {
    const totp = new TOTP(account.totpSecret);
    const code = totp.now();
    const remaining = totp.remaining();

    return {
      email: account.email,
      code,
      remaining,
      expiresAt: new Date(Date.now() + remaining * 1000)
    };
  } catch (err) {
    return { error: `Failed to generate code: ${err.message}` };
  }
}

/**
 * List all accounts with TOTP enabled
 */
function listAccounts() {
  return Array.from(accounts.values()).map(acc => ({
    email: acc.email,
    hasTotp: !!acc.totpSecret
  }));
}

/**
 * Get account count
 */
function getAccountCount() {
  return accounts.size;
}

module.exports = {
  loadAccounts,
  generate2FA,
  listAccounts,
  getAccountCount
};
