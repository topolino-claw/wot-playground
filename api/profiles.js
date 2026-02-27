const fs = require('fs');
const path = require('path');

const PROFILES_DIR = path.join(__dirname, '..', 'profiles');

// Load all profiles from the profiles directory
function loadProfiles() {
  const profiles = {};
  
  try {
    const files = fs.readdirSync(PROFILES_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(PROFILES_DIR, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const profile = JSON.parse(content);
        profiles[profile.name] = profile;
      }
    }
  } catch (e) {
    console.error('Error loading profiles:', e);
  }
  
  return profiles;
}

let profilesCache = null;

function getProfiles() {
  if (!profilesCache) {
    profilesCache = loadProfiles();
  }
  return profilesCache;
}

function listProfiles() {
  const profiles = getProfiles();
  return Object.values(profiles).map(p => ({
    name: p.name,
    label: p.label,
    description: p.description,
    seedCount: p.seeds?.length || 0
  }));
}

function getProfile(name) {
  const profiles = getProfiles();
  return profiles[name] || null;
}

function reloadProfiles() {
  profilesCache = loadProfiles();
  return profilesCache;
}

module.exports = { listProfiles, getProfile, getProfiles, reloadProfiles };
