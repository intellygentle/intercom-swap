import { ManagerAgent } from './manager.js';

const manager = new ManagerAgent();

// Message handler for Intercom sidechannel
async function handleSidechannelMessage(message, senderPubkey) {
  console.log(`\n═══════════════════════════════════════`);
  console.log(`📨 Incoming P2P Message`);
  console.log(`👤 From: ${senderPubkey.substring(0, 16)}...`);
  console.log(`💬 Message: ${message}`);
  console.log(`═══════════════════════════════════════`);

  // Process through Manager Agent
  const response = await manager.handleRequest(message);
  
  // Format response for sidechannel
  let replyText;
  if (typeof response === 'object') {
    replyText = `📌 Topic: ${response.topic}\n📄 Summary: ${response.summary}\n⏱️ Processed in: ${response.elapsed}`;
  } else {
    replyText = response;
  }

  console.log(`\n📤 Reply ready to send back via sidechannel`);
  return replyText;
}

// Simulate P2P message for testing
async function simulateP2PMessage() {
  console.log('\n🌐 INTERCOM RESEARCH AGENT - P2P Simulation');
  console.log('════════════════════════════════════════════\n');

  const testMessages = [
    { msg: 'research: Trac Network', from: '2e81df46d71bd9c92f2e8a4734425965e3391a5add832202297d6afe86382803' },
    { msg: 'help', from: 'abcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab' }
  ];

  for (const test of testMessages) {
    const reply = await handleSidechannelMessage(test.msg, test.from);
    console.log('\n📬 Would send reply via /sc_send:');
    console.log('─────────────────────────────────');
    console.log(reply);
    console.log('─────────────────────────────────\n');
  }
}

simulateP2PMessage();

export { handleSidechannelMessage };
