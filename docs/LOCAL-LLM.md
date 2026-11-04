# Local LLM for the Blockle agent

The wallet's chat agent (and the Copilot features built on it) can think on a
model running on **your own computer** instead of Blockle's hosted brain. It is
private (prompts, balances and keys never leave your machine), unlimited (no
hosted quota), free, and it takes load off the Blockle servers.

Any OpenAI-compatible server works. The wallet calls `<base>/v1/chat/completions`
and lists what is installed with `<base>/v1/models`. No API key is needed.

## Ollama (recommended)

1. Install from https://ollama.com/download
2. Pull a model: `ollama pull llama3.1:8b` (8B is the floor for trading chat;
   `qwen2.5:14b` or a 70B model is better if your GPU allows)
3. Start it so the wallet can reach it:
   - **Web wallet** (blockle.org/wallet): the browser calls `localhost` directly,
     but Ollama must allow the site origin:
     `OLLAMA_ORIGINS="https://blockle.org" ollama serve`
   - **Mobile wallet**: your phone must reach your computer over the LAN:
     `OLLAMA_HOST=0.0.0.0 ollama serve`, then use `http://<your-computer-ip>:11434`
4. In the wallet: Agent → **🧠 Brain** (web) or Agent → **Connect** → *Local LLM*
   (mobile). Pick Ollama, tap **Detect** to list models, **Test connection**, save.

## LM Studio

Download a chat model, open the Developer tab → **Start Server** (port 1234).
Enable **CORS** for the web wallet, or **Serve on local network** for the phone.

## Anything else

llama.cpp server, vLLM, LocalAI, Jan… choose *Custom*, enter the base URL
(without `/v1`), and the exact model name. The server must allow cross-origin
requests from `https://blockle.org` for the web wallet.

## What stays hosted

Price feeds, token due-diligence signals and the Moon feed still come from
Blockle's read-only APIs; only the *thinking* moves to your machine. Cloud paper
bots (the server-side runner) do not use an LLM at all.
