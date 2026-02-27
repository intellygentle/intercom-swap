import fs from 'fs';

// ---------------------------------------------------------------------------
// Skills loader — reads skills.md from the project root at startup.
// Provides the agent with identity, style rules, and domain knowledge.
// ---------------------------------------------------------------------------
function loadSkills() {
  const candidates = [
    new URL('../../skills.md', import.meta.url).pathname,
    new URL('../../SKILLS.md', import.meta.url).pathname,
    new URL('./skills.md', import.meta.url).pathname,
  ];
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        console.log(`📚 Skills loaded from: ${filePath}`);
        return content;
      }
    } catch (_) {}
  }
  console.log('📚 No skills.md found — running without skill context.');
  return null;
}

const SKILLS = loadSkills();

// ---------------------------------------------------------------------------
// Parse skills.md into a structured object for easy lookup.
// Sections are keyed by their heading text (lowercased).
// ---------------------------------------------------------------------------
function parseSkillSections(skillsText) {
  if (!skillsText) return {};
  const sections = {};
  let currentKey = null;
  let currentLines = [];

  for (const line of skillsText.split('\n')) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      if (currentKey) sections[currentKey] = currentLines.join('\n').trim();
      currentKey = headingMatch[1].toLowerCase();
      currentLines = [];
    } else if (currentKey) {
      currentLines.push(line);
    }
  }
  if (currentKey) sections[currentKey] = currentLines.join('\n').trim();
  return sections;
}

const SKILL_SECTIONS = parseSkillSections(SKILLS);

// ---------------------------------------------------------------------------
// Truncate text at a complete sentence boundary within a character budget.
// Never cuts mid-word or mid-sentence.
// ---------------------------------------------------------------------------
function truncateAtSentence(text, maxChars = 1200) {
  if (!text || text.length <= maxChars) return text;
  const slice = text.substring(0, maxChars);
  const lastPeriod = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('.\n'),
  );
  if (lastPeriod > maxChars * 0.4) {
    return slice.substring(0, lastPeriod + 1);
  }
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 0 ? slice.substring(0, lastSpace) : slice) + '…';
}

// ---------------------------------------------------------------------------
// HTTP client — mirrors the pattern in src/price/request.js.
// Works in Node, Pear desktop, and Bare (bare-fetch fallback).
// ---------------------------------------------------------------------------
async function fetchJson(url, { timeoutMs = 10000, headers = {} } = {}) {
  let baseFetch = globalThis.fetch;
  if (typeof baseFetch !== 'function') {
    try {
      const mod = await import('bare-fetch');
      baseFetch = mod?.default || mod?.fetch || mod;
    } catch (_e) {
      throw new Error('fetch is not available. Install bare-fetch: pear install bare-fetch');
    }
  }

  const ms = Math.max(1, Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : 10000);
  const Controller = globalThis.AbortController;

  const doFetch = async (signal) => {
    const init = {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
      ...(signal ? { signal } : {}),
    };
    const res = await baseFetch(url, init);
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = text.slice(0, 200);
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch (_e) {
      const err = new Error('Invalid JSON');
      err.body = text.slice(0, 200);
      throw err;
    }
  };

  if (typeof Controller !== 'function') {
    const timeout = new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    );
    return Promise.race([doFetch(null), timeout]);
  }

  const controller = new Controller();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await doFetch(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Normalize a topic string — strips question phrasing so that inputs like
// "What is Bitcoin?" and "bitcoin" both resolve to the same Wikipedia title.
// ---------------------------------------------------------------------------
function normalizeTopic(raw) {
  return raw
    .trim()
    // Remove leading question words
    .replace(/^(what is|what are|who is|who are|what was|what were|tell me about|explain|define|how does|how do)\s+/i, '')
    // Remove trailing question mark
    .replace(/\?+$/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Worker — fetches a Wikipedia intro section for a given topic.
// Returns a complete-sentence summary capped at ~1200 chars.
// ---------------------------------------------------------------------------
async function researchWikipedia(topic) {
  const encodedTopic = encodeURIComponent(topic);
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&format=json` +
    `&prop=extracts&exintro=true&explaintext=true&titles=${encodedTopic}`;

  try {
    const data = await fetchJson(url, {
      timeoutMs: 15000,
      headers: { 'User-Agent': 'IntercomResearchAgent/1.0' },
    });

    const pages = data.query.pages;
    const pageId = Object.keys(pages)[0];

    // -----------------------------------------------------------------------
    // If exact title not found, fall back to Wikipedia's search API to find
    // the closest matching article title and retry with that.
    // -----------------------------------------------------------------------
    if (pageId === '-1') {
      const searchUrl =
        `https://en.wikipedia.org/w/api.php?action=opensearch&format=json` +
        `&limit=1&search=${encodedTopic}`;

      const searchData = await fetchJson(searchUrl, {
        timeoutMs: 15000,
        headers: { 'User-Agent': 'IntercomResearchAgent/1.0' },
      });

      // opensearch returns [query, [titles], [descriptions], [urls]]
      const titles = searchData[1];
      if (!titles || titles.length === 0) {
        return `No Wikipedia article found for "${topic}". Try a different spelling or a broader term.`;
      }

      // Retry with the best matching title
      return researchWikipedia(titles[0]);
    }

    const extract = pages[pageId].extract;
    if (!extract || !extract.trim()) {
      return `Wikipedia has an article for "${topic}" but it contains no intro text.`;
    }

    return truncateAtSentence(extract, 1200);
  } catch (error) {
    return `Error fetching Wikipedia: ${error.message}`;
  }
}

// ---------------------------------------------------------------------------
// Build the final response string.
// Injects a relevant skills.md snippet if the topic matches a known domain.
// ---------------------------------------------------------------------------
function buildResponse(topic, summary, elapsedMs) {
  const topicLower = topic.toLowerCase();
  let skillNote = '';

  for (const [sectionKey, sectionBody] of Object.entries(SKILL_SECTIONS)) {
    if (sectionKey.includes(topicLower) || sectionBody.toLowerCase().includes(topicLower)) {
      const snippet = truncateAtSentence(sectionBody, 200);
      if (snippet) {
        skillNote = `📘 Agent context: ${snippet}\n`;
        break;
      }
    }
  }

  return (
    `📌 Topic: ${topic}\n` +
    (skillNote ? `${skillNote}` : '') +
    `📄 Summary: ${summary}\n` +
    `⏱️ Processed in: ${elapsedMs}ms`
  );
}

// ---------------------------------------------------------------------------
// Payload deserializer — unwraps Trac sidechannel envelopes into plain text.
// Envelope shape: { type, id, channel, from, message, ts, ttl, ... }
// ---------------------------------------------------------------------------
function deserializePayload(payload) {
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object') return deserializePayload(parsed);
    } catch (_) {}
    return payload;
  }

  if (payload?.constructor?.name === 'Buffer') {
    return deserializePayload(payload.toString('utf8'));
  }

  if (payload && typeof payload === 'object') {
    if (payload.message !== undefined) return deserializePayload(payload.message);
    for (const prop of ['text', 'content', 'data']) {
      if (payload[prop] != null) return String(payload[prop]);
    }
    try { return JSON.stringify(payload); } catch (_) { return String(payload); }
  }

  return String(payload);
}

// ---------------------------------------------------------------------------
// Protocol message filter — silently drops internal Trac/swap envelopes.
// ---------------------------------------------------------------------------
function isProtocolMessage(message) {
  if (!message || typeof message !== 'string') return false;
  const trimmed = message.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return false;
    const protocolTypes = [
      'agent.announce', 'agent.status',
      'swap.rfq', 'swap.quote', 'swap.terms',
      'swap.svc_announce', 'swap.quote_accept', 'swap.swap_invite',
      'svc_announce', 'ping', 'pong',
    ];
    if (parsed.type && protocolTypes.includes(parsed.type)) return true;
    if (parsed.protocol && typeof parsed.protocol === 'string') return true;
    return false;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Echo filter — returns true for messages that are our own broadcasts
// bouncing back, so we never process our own output as a new command.
// ---------------------------------------------------------------------------
function isOwnEcho(trimmed) {
  return (
    trimmed.startsWith('📌 Topic:') ||
    trimmed.startsWith('🤖 Research Agent') ||
    trimmed.startsWith('❓') ||
    trimmed.startsWith('📘 Agent context:') ||
    trimmed.startsWith('🤖 Research Agent — Online')
  );
}

// ---------------------------------------------------------------------------
// Research Agent — main message handler class.
// ---------------------------------------------------------------------------
class ResearchAgentHandler {
  constructor(sidechannel) {
    this.sidechannel = sidechannel;
    this.name = 'Research Agent';
    this._announced = false;
    const style = SKILL_SECTIONS['response style'] ?? null;
    console.log(`🤖 ${this.name} initialized and listening for P2P messages`);
    if (style) console.log(`📋 Response style loaded from skills.md`);
  }

  // ---------------------------------------------------------------------------
  // announce — broadcasts a one-time introduction to the channel after a short
  // delay so that peers have time to establish connections before the message
  // is sent. If no peers are connected yet it resets _announced so it can be
  // retried on the next call (e.g. wired to a peer-connect event).
  // ---------------------------------------------------------------------------
  async announce(channel, { delayMs = 6000 } = {}) {
    if (this._announced) return;
    this._announced = true;

    const domains = SKILL_SECTIONS['knowledge domains'] ?? '';

    // Format the domains list cleanly — strip markdown bullet chars if present.
    const domainLine = domains
      ? domains
          .split('\n')
          .map((l) => l.replace(/^[-*•]\s*/, '').trim())
          .filter(Boolean)
          .join(', ')
      : '';

    const intro =
      `🤖 Research Agent — Online\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `I am a research assistant running on the Trac P2P network. use the command like this </sc_send --channel "0000intercom" --message "research: Bitcoin">.\n` +
      `I fetch Wikipedia summaries and return complete, readable answers.\n\n` +
      `📖 How to use me:\n` +
      `  research: <topic>   — look up any topic\n` +
      `  help                — show available commands\n\n` +
      `💡 Examples:\n` +
      `  research: Bitcoin\n` +
      `  research: What is cryptocurrency?\n` +
      `  research: Who is satoshi\n` +
      (domainLine ? `\n🗂️  I know about: ${domainLine}\n` : '') +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📡 Listening on channel: ${channel}`;

    // Wait for peers to connect before broadcasting.
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    if (!this.sidechannel) {
      console.log(`[research-agent] No sidechannel available — announcement skipped.`);
      this._announced = false;
      return;
    }

    console.log(`\n📣 Announcing Research Agent on channel "${channel}"...`);
    try {
      const sent = this.sidechannel.broadcast(channel, { text: intro });
      if (sent) {
        console.log(`✅ Agent announcement broadcast successfully!`);
      } else {
        console.log(`[research-agent] No peers connected yet — announcement skipped, will retry.`);
        this._announced = false;
      }
    } catch (err) {
      console.error(`❌ Failed to broadcast announcement: ${err.message}`);
      this._announced = false;
    }
  }

  async handleMessage(channel, payload, connection) {
    const message = deserializePayload(payload);

    // Resolve sender key for logging.
    const remoteKey = connection?.remotePublicKey;
    let senderKey = 'unknown';
    if (remoteKey) {
      senderKey = (typeof remoteKey.toString === 'function'
        ? remoteKey.toString('hex')
        : String(remoteKey)
      ).substring(0, 16);
    } else if (payload?.from) {
      senderKey = String(payload.from).substring(0, 16);
    }

    // Drop protocol envelopes silently.
    if (isProtocolMessage(message)) return;

    // Drop echoes of our own broadcasts.
    const trimmed = message.trim();
    if (isOwnEcho(trimmed)) return;

    // If the agent hasn't announced yet and we just received our first real
    // message, it means peers are now connected — try announcing now.
    if (!this._announced) {
      this.announce(channel, { delayMs: 0 });
    }

    console.log(`\n═══════════════════════════════════════`);
    console.log(`📨 Research Agent received P2P message`);
    console.log(`👤 From: ${senderKey}...`);
    console.log(`📢 Channel: ${channel}`);
    console.log(`💬 Message: ${message}`);
    console.log(`═══════════════════════════════════════`);

    if (!message || !message.trim()) return;

    let response = null;
    const lowerMessage = message.toLowerCase().trim();

if (lowerMessage.startsWith('research:')) {
  const rawTopic = message.substring(9).trim();
  const topic = normalizeTopic(rawTopic);   // <-- add this
  if (!topic) {
        response = `❓ Please provide a topic. Example: research: Artificial Intelligence`;
      } else {
        console.log(`📋 Researching "${topic}"...`);
        const startTime = Date.now();
        const summary = await researchWikipedia(topic);
        const elapsed = Date.now() - startTime;
        response = buildResponse(topic, summary, elapsed);
        console.log(`✅ Research completed in ${elapsed}ms`);
      }
    } else if (lowerMessage === 'help' || lowerMessage === '/help') {
      const capabilities = SKILL_SECTIONS['capabilities'] ?? 'research: [topic] - Research a topic';
      response =
        `🤖 Research Agent — Help\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${capabilities}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Example: research: Bitcoin`;
    } else {
      console.log(`[research-agent] unrecognized command from ${senderKey}, sending usage hint.`);
      response =
        `🤖 Research Agent — I didn't understand that command.\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Here's how to use me:\n\n` +
        `  research: <topic>   — look up any topic\n` +
        `  help                — show this message\n\n` +
        `Examples:\n` +
        `  research: Bitcoin\n` +
        `  research: Artificial Intelligence\n` +
        `  research: Peer-to-peer networking\n\n` +
        `📡 Running on the Trac P2P network (intercom-swap)`;
    }

    if (response) {
      console.log(`\n📤 Response prepared:`);
      console.log(`───────────────────────────────────────`);
      console.log(response);
      console.log(`───────────────────────────────────────`);

      if (this.sidechannel) {
        console.log(`📡 Broadcasting response on channel "${channel}"...`);
        try {
          const sent = this.sidechannel.broadcast(channel, { text: response });
          if (sent) {
            console.log(`✅ Response broadcast successfully!`);
          } else {
            console.warn(`⚠️ broadcast() returned false — no active connections on "${channel}" yet.`);
          }
        } catch (err) {
          console.error(`❌ Failed to broadcast response: ${err.message}`);
        }
      }
    }

    return response;
  }
}

export { ResearchAgentHandler, researchWikipedia, deserializePayload, fetchJson };