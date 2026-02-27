const express = require('express');
const path = require('path');
const oracleApi = require('./api/oracle');
const profilesApi = require('./api/profiles');
const consensusApi = require('./api/consensus');

const app = express();
const PORT = 8090;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// API Routes
app.get('/api/graph', async (req, res) => {
  try {
    const { seed, hops = 2, profile } = req.query;
    
    let rootPubkey = seed;
    
    // If profile specified, use its root
    if (profile && !seed) {
      const profileData = profilesApi.getProfile(profile);
      if (profileData) {
        rootPubkey = profileData.root;
      }
    }
    
    if (!rootPubkey) {
      return res.status(400).json({ error: 'Missing seed or profile parameter' });
    }
    
    const graphData = await oracleApi.getGraph(rootPubkey, parseInt(hops), profile);
    res.json(graphData);
  } catch (error) {
    console.error('Graph API error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/profiles', (req, res) => {
  try {
    const profiles = profilesApi.listProfiles();
    res.json(profiles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/profile/:name', (req, res) => {
  try {
    const profile = profilesApi.getProfile(req.params.name);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json(profile);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/consensus', async (req, res) => {
  try {
    const { hops = 2 } = req.query;
    const consensusData = await consensusApi.getConsensusGraph(parseInt(hops));
    res.json(consensusData);
  } catch (error) {
    console.error('Consensus API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🌐 WoT Playground running at http://localhost:${PORT}`);
});
