function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function shouldRedactKey(key) {
  const k = String(key || '').toLowerCase();
  // Secrets + access tokens.
  if (k.includes('token')) return true;
  if (k.includes('api_key') || k.includes('apikey')) return true;
  if (k.includes('authorization') || k === 'auth') return true;
  if (k.includes('macaroon')) return true;
  if (k.includes('seed')) return true;
  if (k.includes('password')) return true;

  // Swap-sensitive material.
  if (k.includes('preimage')) return true;
  // Invites/welcomes: redact only the payload fields (base64 blobs or nested objects), not
  // non-secret policy fields like invite_required/invite_prefixes/inviter_keys.
  if (k === 'invite' || k === 'invite_b64' || k.endsWith('_invite_b64')) return true;
  if (k === 'welcome' || k === 'welcome_b64' || k.endsWith('_welcome_b64')) return true;

  return false;
}

function truncateString(s, max = 2000) {
  const text = String(s);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…<truncated ${text.length - max} chars>`;
}

export function redactSensitive(value, { maxString = 2000 } = {}) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateString(value, maxString);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();

  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v, { maxString }));
  }

  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (shouldRedactKey(k)) out[k] = '<redacted>';
      else out[k] = redactSensitive(v, { maxString });
    }
    return out;
  }

  // Fallback: best-effort stringification.
  try {
    return truncateString(JSON.stringify(value), maxString);
  } catch (_e) {
    return '<unserializable>';
  }
}
