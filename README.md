# Collaborative Research Team - Intercom Fork

## Agent Information

**Reward Address (TAP Wallet):** `trac1ajdk79pq47u0qqwr5qcph3y28j93gcywecawjec9w77wcrn5vqsqs825pq`

**Development Peer Address (CLI):** `trac1txz842lvhmtfxkt932j0c5le902q40erwgpc4ddvxc2add5wygzsd5xzdn`

**Peer Public Key:** `59847aabecbed69359658aa4fc53f92bd40abf2372038ab5ac3615d6b68e2205`


---

## 📡 Trac Address

trac1ajdk79pq47u0qqwr5qcph3y28j93gcywecawjec9w77wcrn5vqsqs825pq

---

## ✨ What It Does

- Joins the `0000intercom` P2P sidechannel on startup
- Announces itself to the network so peers know it is available
- Responds to `research: <topic>` commands with complete Wikipedia summaries
- Returns full, sentence-complete answers — never truncated mid-thought
- Guides users who send unrecognized commands with usage instructions
- Loads agent identity and domain knowledge from `skills.md` at startup

---

## 🚀 How to Use the Agent

```
pear run ~/intercom-swap
```

Once the agent is running, any peer on the Trac network can interact with it.

**1. Join the intercom channel:**

/sc_join --channel "0000intercom"

**2. Send a research query:**

/sc_send --channel "0000intercom" --message "research: Bitcoin"
/sc_send --channel "0000intercom" --message "research: What is cryptocurrency?"
/sc_send --channel "0000intercom" --message "research: Who is satoshi"

**3. Get help:**

/sc_send --channel "0000intercom" --message "help"

### Command Reference

| Command | Description |
|---|---|
| `research: <topic>` | Look up any topic on Wikipedia |
| `help` | Show available commands and examples |

---

## 🛠️ Running It Yourself

### Prerequisites

- [Pear Runtime](https://pears.com) installed
- Node.js 20+

### Install & Run

```bash
https://github.com/intellygentle/intercom-swap
cd intercom-swap
npm install
pear run ~/intercom-swap
```
## To confirm if others can use it while it is running on your pc

```
cd intercom-swap

https://github.com/user-attachments/assets/f3f72641-a097-4972-8a6d-c592fc97f907


pear run . --peer-store-name my-node
```

## Test
```
/sc_join --channel "0000intercom"
/sc_send --channel "0000intercom" --message "research: What is cryptocurrency?"
```

The agent starts automatically with the node. On startup you will see:


📚 Skills loaded from: /path/to/intercom-swap/skills.md
🤖 Research Agent initialized and listening for P2P messages
📋 Response style loaded from skills.md
Sidechannel: ready
📣 Announcing Research Agent on channel "0000intercom"...
✅ Agent announcement broadcast successfully!

---

## 🏗️ Architecture


intercom-swap/
├── index.js                          # Entry point — wires peer, MSB, sidechannel, agent
├── skills.md                         # Agent identity, domains, and response style
└── features/
├── research-agent/
│   └── index.js                  # ResearchAgentHandler — core agent logic
├── sidechannel/
│   └── index.js                  # Trac P2P sidechannel transport
├── sc-bridge/
│   └── index.js                  # WebSocket bridge for external integrations
└── price/
└── index.js                  # Price oracle feature

### Message Flow


Peer on network
│
│  /sc_send --channel "0000intercom" --message "research: Bitcoin"
▼
Trac Sidechannel (0000intercom)
│
▼
ResearchAgentHandler.handleMessage()
│
├── isProtocolMessage()  →  drop silently if internal envelope
├── isOwnEcho()          →  drop silently if our own broadcast
│
▼
researchWikipedia(topic)
│  Wikipedia API
▼
truncateAtSentence(extract, 1200)   ← complete sentence, never mid-thought
│
▼
buildResponse(topic, summary, elapsed)
│  injects skills.md context if topic matches a known domain
▼
sidechannel.broadcast(channel, { text: response })
│
▼
All peers on "0000intercom" receive the response

---

## 🧠 skills.md — Agent Context

The agent reads `skills.md` at startup to load its identity, response style, and domain knowledge. Updating this file changes how the agent presents itself on the network without any code changes.

```markdown
# Research Agent Skills

## Identity
You are a Research Agent running on the Trac peer-to-peer network...

## Capabilities
- Research any topic using the `research: <topic>` command
- Return complete, well-formed summaries...

## Response Style
- Always return complete sentences — never cut off mid-thought
- Keep summaries informative but concise...

## Knowledge Domains
- Cryptocurrency and blockchain technology
- Peer-to-peer networking protocols
- Distributed systems
- General encyclopedic knowledge via Wikipedia
```

---

## 📸 Proof of Work

### Agent receiving and responding to a query from a network peer


📩 [0000intercom] from 59847aabecbed693...:
research: Bitcoin
═══════════════════════════════════════
📨 Research Agent received P2P message
👤 From: 59847aabecbed693...
📢 Channel: 0000intercom
💬 Message: research: Bitcoin
═══════════════════════════════════════
📋 Researching "Bitcoin"...
✅ Research completed in 741ms
📤 Response prepared:
───────────────────────────────────────
📌 Topic: Bitcoin
📄 Summary: Bitcoin (abbreviation: BTC; sign: ₿) is the first
decentralized cryptocurrency. Based on a free-market ideology,
bitcoin was invented in 2008 when an unknown person published a
white paper under the pseudonym of Satoshi Nakamoto. Use of bitcoin
as a currency began in 2009, with the release of its open-source
implementation.
⏱️ Processed in: 741ms
───────────────────────────────────────
✅ Response broadcast successfully!

### Agent guiding a peer who used the wrong command format


📩 [0000intercom] from 27e4908d63e1e0af...:
/ask What is Bitcoin?
🤖 Research Agent — I didn't understand that command.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Here's how to use me:
research: <topic>   — look up any topic
help                — show this message
Examples:
research: Bitcoin
research: What is cryptocurrency?
research: Who is satoshi
📡 Running on the Trac P2P network (intercom-swap)

### Agent announcing itself on startup


📣 Announcing Research Agent on channel "0000intercom"...
🤖 Research Agent — Online
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
I am a research assistant running on the Trac P2P network. use the command like this:

```
sc_send--channel"0000intercom"--message "research: Bitcoin"
```

I fetch Wikipedia summaries and return complete, readable answers.
📖 How to use me:
research: <topic>   — look up any topic
help                — show available commands
💡 Examples:
research: Bitcoin
research: What is Cryptocurrency
research: Who is Satoshi?
🗂️  I know about: Cryptocurrency and blockchain technology,
Peer-to-peer networking protocols, Distributed systems,
General encyclopedic knowledge via Wikipedia
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📡 Listening on channel: 0000intercom
✅ Agent announcement broadcast successfully!

---

## 🔧 Key Implementation Details

**Sentence-complete summaries** — the `truncateAtSentence()` function finds the last period-space boundary within a 1200-character budget so responses always end at a natural point rather than cutting mid-word or mid-thought.

**skills.md context injection** — when a query topic matches a section heading or body in `skills.md`, a relevant snippet is prepended to the response under `📘 Agent context:`.

**Echo filtering** — the agent detects its own broadcast echoes by prefix and drops them silently, preventing infinite response loops on shared open channels.

**Protocol envelope filtering** — internal Trac/swap messages (`swap.rfq`, `ping`, `agent.announce`, etc.) are identified and dropped before they reach command parsing.

**Announce-on-first-message fallback** — if no peers are connected when the scheduled 6-second announcement fires, `_announced` resets to `false` and the announcement is retried the moment the first real message arrives.

---

video proof 

https://github.com/user-attachments/assets/3d3b101c-d771-4d4b-a8e8-ebdd72ad32f3



## 📄 License

MIT
