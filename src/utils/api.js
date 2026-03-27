const MLB_SCHEDULE_URL = 'https://statsapi.mlb.com/api/v1/schedule';
const TEAM_ABBREVIATION_ALIASES = {
  AZ: 'ARI',
};

function normalizeTeamAbbreviation(value) {
  const code = String(value || '').trim().toUpperCase();
  return TEAM_ABBREVIATION_ALIASES[code] || code;
}

function ensureOk(response, fallbackMessage) {
  if (!response.ok) {
    throw new Error(fallbackMessage);
  }
}

function isValidDateString(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    return false;
  }

  return !Number.isNaN(new Date(`${date}T12:00:00Z`).getTime());
}

function buildQueryPath(path, params) {
  const search = new URLSearchParams(params);
  return `${path}?${search.toString()}`;
}

function formatTime(dateTime) {
  if (!dateTime) {
    return 'TBD';
  }

  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
      timeZoneName: 'short',
    }).format(new Date(dateTime));
  } catch (error) {
    return dateTime;
  }
}

function mapScheduleGame(game) {
  return {
    gamePk: game.gamePk,
    gameDate: game.gameDate,
    gameTime: formatTime(game.gameDate),
    status: game.status?.detailedState || game.status?.abstractGameState || 'Scheduled',
    venue: game.venue?.name || 'Unknown venue',
    doubleHeader: game.doubleHeader || 'N',
    awayTeam: {
      id: game.teams?.away?.team?.id || '',
      name: game.teams?.away?.team?.name || 'Away Team',
      abbreviation: normalizeTeamAbbreviation(
        game.teams?.away?.team?.abbreviation || game.teams?.away?.team?.teamCode?.toUpperCase() || 'AWY'
      ),
      probablePitcher: game.teams?.away?.probablePitcher || null,
    },
    homeTeam: {
      id: game.teams?.home?.team?.id || '',
      name: game.teams?.home?.team?.name || 'Home Team',
      abbreviation: normalizeTeamAbbreviation(
        game.teams?.home?.team?.abbreviation || game.teams?.home?.team?.teamCode?.toUpperCase() || 'HME'
      ),
      probablePitcher: game.teams?.home?.probablePitcher || null,
    },
  };
}

export async function fetchScheduleByDate(date) {
  const url = `${MLB_SCHEDULE_URL}?sportId=1&date=${date}&hydrate=probablePitcher,venue,team`;
  const response = await fetch(url);
  ensureOk(response, 'Unable to load the MLB schedule feed.');
  const data = await response.json();
  const games = data?.dates?.[0]?.games || [];
  return games.map(mapScheduleGame);
}

export async function fetchRotowireLineups(date) {
  const response = await fetch(buildQueryPath('/api/rotowire/lineups', { date }));
  ensureOk(response, 'Unable to reach the local RotoWire proxy endpoint.');
  return response.json();
}

export async function fetchFallbackLineups() {
  const response = await fetch('/api/fallback-lineups');
  ensureOk(response, 'Unable to load spreadsheet fallback lineups.');
  return response.json();
}

export async function fetchWorkbookModelData() {
  const response = await fetch('/api/workbook-model-data');
  ensureOk(response, 'Unable to load workbook model data.');
  return response.json();
}

export async function fetchFinalResultsByDate(date) {
  if (!isValidDateString(date)) {
    throw new Error('Choose a valid date to load final results.');
  }

  const response = await fetch(buildQueryPath('/api/mlb/results', { date }));
  ensureOk(response, 'Unable to load completed MLB results for this date.');
  return response.json();
}

export async function fetchPitcherLastOuting(pitcherId, beforeDate) {
  const response = await fetch(
    buildQueryPath('/api/mlb/pitcher-last-outing', {
      pitcherId,
      before: beforeDate,
    })
  );
  ensureOk(response, 'Unable to load the pitcher previous outing.');
  return response.json();
}

export async function fetchPowerRankings() {
  const response = await fetch('/api/mlb/power-rankings');
  ensureOk(response, 'Unable to load MLB.com power rankings.');
  return response.json();
}

export async function fetchSportsInsightsWeather({ awayTeam, homeTeam, date }) {
  const response = await fetch(
    buildQueryPath('/api/mlb/weather', {
      awayTeam,
      homeTeam,
      date,
    })
  );
  ensureOk(response, 'Unable to load Sports Insights weather.');
  return response.json();
}

export async function fetchLineupInjuries(teams) {
  const response = await fetch(
    buildQueryPath('/api/balldontlie/lineup-injuries', {
      teams: teams.join(','),
    })
  );
  ensureOk(response, 'Unable to load Ball Don’t Lie lineup injuries.');
  return response.json();
}
