# Trick Prediction — Online Multiplayer

Play the trick-prediction trump card game with friends in the browser. **Trump rotates each round:** Spades → Hearts → Clubs → Diamonds → repeat. Each round you get more cards, predict how many tricks you'll win, then play. Score tricks won if your prediction is exact; lose points for how far off you were.

## Features

- **Realistic playing cards** (suits, corners, current trump highlighted)
- **Hidden hands** — the server only sends you your own cards
- **Private predictions** until everyone has locked in
- **Room codes** — create a room, share the 6-letter code, 2–6 players
- Same rules as the original Python game

## Quick start

```bash
cd trick-prediction-game
npm install
npm start
```

Open **http://localhost:3000** in each player's browser.

1. One player **Create Room** and copies the room code.
2. Friends **Join Room** with that code.
3. Host clicks **Start Game** when everyone is in the lobby.

## Play online with friends

For friends on other networks, deploy the server (Render, Railway, Fly.io, a VPS, etc.) and share the public URL. Everyone uses the same site URL; room codes work across the internet.

Example with [ngrok](https://ngrok.com) for a quick test:

```bash
npm start
# In another terminal:
ngrok http 3000
```

Share the `https://….ngrok.io` link with friends.

## How to play

| Phase | What happens |
|--------|----------------|
| **Prediction** | Each player secretly picks 0–N tricks (N = cards this round) |
| **Tricks** | Follow suit if you can; round’s trump suit beats others; highest wins |
| **Scoring** | Predict **0** and win 0 → **+1**; predict **0** and win any → **−1**. Exact match → +tricks won. Wrong → **minus your prediction** (e.g. predict 3, wrong → **−3**) |

Round 1 deals 1 card per player, round 2 deals 2, and so on until the deck is used (`52 ÷ players` rounds).

## Tech

- **Node.js** + **Express** + **Socket.io** (authoritative server)
- Vanilla HTML/CSS/JS frontend

## Project layout

```
server/     Game logic, rooms, WebSocket events
public/     UI, card styling, client
```
