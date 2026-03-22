function numberOrFallback(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

const TEAM_LOGO_CODE_MAP = {
  ARI: 'ari',
  ATL: 'atl',
  BAL: 'bal',
  BOS: 'bos',
  CHC: 'chc',
  CWS: 'chw',
  CIN: 'cin',
  CLE: 'cle',
  COL: 'col',
  DET: 'det',
  HOU: 'hou',
  KC: 'kc',
  LAA: 'laa',
  LAD: 'lad',
  MIA: 'mia',
  MIL: 'mil',
  MIN: 'min',
  NYM: 'nym',
  NYY: 'nyy',
  ATH: 'oak',
  PHI: 'phi',
  PIT: 'pit',
  SD: 'sd',
  SF: 'sf',
  SEA: 'sea',
  STL: 'stl',
  TB: 'tb',
  TEX: 'tex',
  TOR: 'tor',
  WSH: 'wsh',
};

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function hasUsablePitcherName(value, abbreviation) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return false;
  }

  return normalizeName(trimmed) !== normalizeName(`${abbreviation} Starter`);
}

export function createLineupFromNames(teamName, hitterRatings, names = []) {
  const shortName = teamName.split(' ').slice(-1)[0] || teamName;
  return hitterRatings.map((rating, index) => ({
    slot: index + 1,
    name: names[index] || `${shortName} Batter ${index + 1}`,
    rating,
    manualName: false,
    manualRating: false,
    manualSlot: false,
  }));
}

export function createLineupFromWorkbookEntries(teamName, hitterRatings, entries = []) {
  const baseLineup = createLineupFromNames(
    teamName,
    hitterRatings,
    entries.map((entry) => entry?.name)
  );

  return baseLineup.map((player, index) => ({
    ...player,
    slot: Number(entries[index]?.slot ?? player.slot),
    rating: numberOrFallback(entries[index]?.rating, player.rating),
  }));
}

function buildPitcherDefaults(team, modelData, pitcherName) {
  const defaultKRate = (team.starterK9 || modelData.defaultStarterK9) / 27;
  const defaultIp = (team.starterBattersFaced || modelData.defaultStarterBattersFaced) / 4.2;
  return {
    name: pitcherName || `${team.abbreviation} Starter`,
    teamId: team.id,
    mlbamId: null,
    fip: team.starterFip || modelData.defaultStarterFip,
    battersFaced: team.starterBattersFaced || modelData.defaultStarterBattersFaced,
    k9: team.starterK9 || modelData.defaultStarterK9,
    hand: 'R',
    l30KRate: defaultKRate,
    seasonKRate: defaultKRate,
    lastYearKRate: defaultKRate,
    csw: 0.29,
    whip: 1.25,
    currentIp: defaultIp,
    ip2026: defaultIp,
    ip2025: defaultIp,
    ksLastOuting: null,
    lastOutingDate: '',
    lastOutingOpponent: '',
  };
}

function hydrateTeam(teamSeed, sideData, modelData, previousLineup) {
  const lineup = previousLineup?.length
    ? previousLineup
    : createLineupFromNames(teamSeed.name, modelData.defaultHitterRatingsBySpot);

  return {
    id: sideData?.id || teamSeed.id,
    name: sideData?.name || teamSeed.name,
    abbreviation: sideData?.abbreviation || teamSeed.abbreviation,
    bullpenFip: numberOrFallback(teamSeed.bullpenFip, modelData.defaultBullpenFip),
    offenseRating: numberOrFallback(teamSeed.offenseRating, 100),
    probablePitcher: buildPitcherDefaults(teamSeed, modelData, sideData?.probablePitcher?.fullName),
    lineup,
  };
}

export function defaultDateString() {
  return new Date().toISOString().slice(0, 10);
}

export function normalizeNameKey(value) {
  return normalizeName(value);
}

export function buildTeamOptions(modelData) {
  return modelData.teams
    .map((team) => ({
      value: team.abbreviation,
      label: team.abbreviation,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function getTeamLogoUrl(abbreviation) {
  const code = TEAM_LOGO_CODE_MAP[String(abbreviation || '').trim().toUpperCase()];
  return code ? `https://a.espncdn.com/i/teamlogos/mlb/500/${code}.png` : '';
}

export function getTeamByAbbreviation(modelData, abbreviation) {
  return modelData.teams.find((team) => team.abbreviation === abbreviation) || modelData.teams[0];
}

export function createEmptyGameState(modelData, date = defaultDateString()) {
  const awaySeed = modelData.teams[0];
  const homeSeed = modelData.teams[1];

  return {
    selectedDate: date,
    venue: 'Select an MLB game to begin',
    gameTime: 'TBD',
    gameStatus: 'Awaiting selection',
    environment: {
      parkFactor: modelData.defaultParkFactor,
      temperature: modelData.defaultTemperature,
      windMph: modelData.defaultWindMph,
      windDirection: modelData.windDirections[0].value,
      condition: modelData.weatherPresets[0].value,
    },
    awayTeam: hydrateTeam(awaySeed, null, modelData),
    homeTeam: hydrateTeam(homeSeed, null, modelData),
    workbookModelData: {
      params: {},
      teamObp: {},
      teamKVsR: {},
      teamKVsL: {},
      venueFactors: {},
    },
  };
}

export function buildGameStateFromSelection(game, modelData, currentState) {
  const awaySeed = modelData.teams.find((team) => team.id === game.awayTeam.id) || getTeamByAbbreviation(modelData, game.awayTeam.abbreviation);
  const homeSeed = modelData.teams.find((team) => team.id === game.homeTeam.id) || getTeamByAbbreviation(modelData, game.homeTeam.abbreviation);
  const preserveAwayPitcher =
    currentState.awayTeam.abbreviation === (game.awayTeam.abbreviation || awaySeed.abbreviation) &&
    hasUsablePitcherName(currentState.awayTeam.probablePitcher?.name, awaySeed.abbreviation)
      ? currentState.awayTeam.probablePitcher
      : null;
  const preserveHomePitcher =
    currentState.homeTeam.abbreviation === (game.homeTeam.abbreviation || homeSeed.abbreviation) &&
    hasUsablePitcherName(currentState.homeTeam.probablePitcher?.name, homeSeed.abbreviation)
      ? currentState.homeTeam.probablePitcher
      : null;
  const preserveAwayLineup =
    currentState.awayTeam.abbreviation === (game.awayTeam.abbreviation || awaySeed.abbreviation)
      ? currentState.awayTeam.lineup
      : null;
  const preserveHomeLineup =
    currentState.homeTeam.abbreviation === (game.homeTeam.abbreviation || homeSeed.abbreviation)
      ? currentState.homeTeam.lineup
      : null;

  return {
    ...currentState,
    selectedDate: currentState.selectedDate,
    venue: game.venue || awaySeed.venue || homeSeed.venue,
    gameTime: game.gameTime,
    gameStatus: game.status,
    environment: {
      ...currentState.environment,
      parkFactor: homeSeed.parkFactor || modelData.defaultParkFactor,
    },
    awayTeam: {
      ...hydrateTeam(awaySeed, game.awayTeam, modelData, preserveAwayLineup),
      probablePitcher: {
        ...(preserveAwayPitcher && !game.awayTeam.probablePitcher?.fullName
          ? preserveAwayPitcher
          : buildPitcherDefaults(awaySeed, modelData, game.awayTeam.probablePitcher?.fullName)),
        mlbamId: game.awayTeam.probablePitcher?.id || preserveAwayPitcher?.mlbamId || null,
        hand: game.awayTeam.probablePitcher?.pitchHand?.code || preserveAwayPitcher?.hand || 'R',
      },
    },
    homeTeam: {
      ...hydrateTeam(homeSeed, game.homeTeam, modelData, preserveHomeLineup),
      probablePitcher: {
        ...(preserveHomePitcher && !game.homeTeam.probablePitcher?.fullName
          ? preserveHomePitcher
          : buildPitcherDefaults(homeSeed, modelData, game.homeTeam.probablePitcher?.fullName)),
        mlbamId: game.homeTeam.probablePitcher?.id || preserveHomePitcher?.mlbamId || null,
        hand: game.homeTeam.probablePitcher?.pitchHand?.code || preserveHomePitcher?.hand || 'R',
      },
    },
  };
}

export function updateTeamFromAbbreviation(gameState, side, abbreviation, modelData) {
  const teamSeed = getTeamByAbbreviation(modelData, abbreviation);
  const lineup = createLineupFromNames(teamSeed.name, modelData.defaultHitterRatingsBySpot);

  return {
    ...gameState,
    [side]: {
      ...gameState[side],
      id: teamSeed.id,
      name: teamSeed.name,
      abbreviation: teamSeed.abbreviation,
      offenseRating: teamSeed.offenseRating,
      bullpenFip: teamSeed.bullpenFip,
      probablePitcher: buildPitcherDefaults(teamSeed, modelData),
      lineup,
    },
    environment: side === 'homeTeam'
      ? {
          ...gameState.environment,
          parkFactor: teamSeed.parkFactor || modelData.defaultParkFactor,
        }
      : gameState.environment,
  };
}

export function formatGameLabel(game) {
  return `${game.awayTeam.abbreviation} at ${game.homeTeam.abbreviation} • ${game.gameTime} • ${game.venue}`;
}

export function normalizeLineupFromPosted(postedLineup, currentLineup) {
  return currentLineup.map((player, index) => ({
    ...player,
    name: postedLineup[index]?.name || player.name,
    manualName: false,
  }));
}

export function hasLineupMismatch(currentLineup, postedLineup) {
  if (!postedLineup || postedLineup.length === 0) {
    return false;
  }

  return currentLineup.some((player, index) => normalizeName(player.name) !== normalizeName(postedLineup[index]?.name));
}

export function formatPostedLineupSummary(postedLineup) {
  if (!postedLineup || postedLineup.length === 0) {
    return 'No posted lineup found yet.';
  }

  return postedLineup
    .slice(0, 4)
    .map((player) => player.name)
    .join(', ');
}

export function getFallbackLineupForHand(fallbackLineups, abbreviation, opposingPitcherHand) {
  const teamFallbacks = fallbackLineups?.[abbreviation];
  if (!teamFallbacks) {
    return [];
  }

  const normalizedHand = String(opposingPitcherHand || 'R').toUpperCase() === 'L' ? 'L' : 'R';
  return teamFallbacks[normalizedHand] || teamFallbacks.R || teamFallbacks.L || [];
}

function teamMatches(postedTeam, abbreviation) {
  const normalizedPosted = normalizeName(postedTeam);
  const normalizedAbbreviation = normalizeName(abbreviation);
  return normalizedPosted === normalizedAbbreviation || normalizedPosted.includes(normalizedAbbreviation);
}

export function findRotowireMatchup(games, awayAbbreviation, homeAbbreviation) {
  return (
    games.find(
      (game) =>
        teamMatches(game.awayAbbreviation, awayAbbreviation) &&
        teamMatches(game.homeAbbreviation, homeAbbreviation)
    ) || null
  );
}
