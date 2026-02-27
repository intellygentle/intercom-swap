import { researchWikipedia } from './worker.js';

// Re-export deserializePayload so manager can also handle raw P2P payloads
// if called directly from a sidechannel hook instead of through index.js
function deserializePayload(payload) {
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object') {
        const textProps = ['text', 'message', 'content', 'data'];
        for (const prop of textProps) {
          if (parsed[prop]) return String(parsed[prop]);
        }
        return payload;
      }
    } catch (_) {
      // Not JSON, use as-is
    }
    return payload;
  }

  if (Buffer.isBuffer(payload)) {
    return deserializePayload(payload.toString('utf8'));
  }

  if (payload && typeof payload === 'object') {
    const textProps = ['text', 'message', 'content', 'data'];
    for (const prop of textProps) {
      if (payload[prop]) return String(payload[prop]);
    }
    try {
      return JSON.stringify(payload);
    } catch (_) {
      return String(payload);
    }
  }

  return String(payload);
}

class ManagerAgent {
  constructor() {
    this.name = 'Manager Agent';
  }

  async handleRequest(rawMessage) {
    // Always deserialize before processing — guards against raw P2P payloads
    // reaching the manager directly (e.g. from a test harness or alternate caller)
    const message = deserializePayload(rawMessage);

    console.log(`\n📥 ${this.name} received request: "${message}"`);

    const lowerMessage = message.toLowerCase().trim();

    if (lowerMessage.startsWith('research:')) {
      const topic = message.substring(9).trim();
      console.log(`📋 Delegating research on "${topic}" to Worker Agent...`);
      const result = await this.delegateToWorker(topic);
      return result;
    }
    else if (lowerMessage === 'help' || lowerMessage === '/help') {
      return this.getHelpMessage();
    }
    else {
      return `❓ Unknown command. Try: "research: [topic]" or "help"`;
    }
  }

  async delegateToWorker(topic) {
    console.log(`\n🔄 Worker Agent processing...`);

    const startTime = Date.now();
    const result = await researchWikipedia(topic);
    const elapsed = Date.now() - startTime;

    console.log(`✅ Worker Agent completed in ${elapsed}ms`);

    return {
      topic: topic,
      summary: result,
      processedBy: 'Worker Agent',
      timestamp: new Date().toISOString(),
      elapsed: `${elapsed}ms`
    };
  }

  getHelpMessage() {
    return `
🤖 Collaborative Research Team - Commands:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  research: [topic]  - Research a topic on Wikipedia
  help               - Show this help message
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Example: research: Artificial Intelligence
    `;
  }
}

// Only run test if executed directly
const isMainModule = process.argv[1]?.includes('manager.js');
if (isMainModule) {
  const manager = new ManagerAgent();
  console.log('═══════════════════════════════════════');
  console.log('🤖 COLLABORATIVE RESEARCH TEAM');
  console.log('═══════════════════════════════════════');

  const query = process.argv[2] || 'research: Blockchain';
  const response = await manager.handleRequest(query);

  console.log('\n📤 Final Response:');
  console.log('───────────────────────────────────────');

  if (typeof response === 'object') {
    console.log(`📌 Topic: ${response.topic}`);
    console.log(`⏱️  Time: ${response.elapsed}`);
    console.log(`🤖 By: ${response.processedBy}`);
    console.log(`\n📄 Summary:\n${response.summary}`);
  } else {
    console.log(response);
  }
  console.log('───────────────────────────────────────\n');
}

export { ManagerAgent, deserializePayload };