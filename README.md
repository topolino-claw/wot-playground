# 🌐 WoT Playground

Interactive Nostr Web of Trust graph visualization.

**Live at:** https://wot.fabri.lat

## Features

- **3D/2D Force-Directed Graph** - Beautiful interactive visualization powered by 3d-force-graph
- **Trust Scoring** - Calculates trust based on hop distance and path multiplicity
- **Seed Profiles** - Pre-configured trust anchors for different communities
- **Real-time Relay Queries** - Fetches follow lists directly from Nostr relays
- **Consensus View** - Merged trust scores from multiple profiles

## Trust Algorithm

```
score = distanceWeight × (1 + pathBonus)

Distance Weights:
- 1 hop: 1.0
- 2 hops: 0.5
- 3 hops: 0.25
- 4+ hops: 0.1

Path Bonus: +10% per additional path (max +50%)
```

## API Endpoints

### GET /api/graph
Query parameters:
- `seed` - npub or hex pubkey to start BFS from
- `profile` - Profile name to use seeds from
- `hops` - Max hops (1-4, default 2)

### GET /api/profiles
List all available seed profiles.

### GET /api/profile/:name
Get a specific profile configuration.

### GET /api/consensus
Get merged consensus graph from all profiles.

## Profiles

- **topolino-seeds** - 40 curated high-ratio accounts
- **nostr-devs** - Core protocol developers
- **bitcoin-educators** - Bitcoin thought leaders
- **consensus** - Merged from all profiles

## Development

```bash
npm install
npm start
```

Server runs on port 8090.

## Tech Stack

- **Backend:** Node.js, Express, WebSocket (nostr-tools)
- **Frontend:** Vanilla JS, 3d-force-graph, Three.js
- **Styling:** CSS (dark theme)

## License

MIT
