const ROTOWIRE_URL = 'https://www.rotowire.com/baseball/daily-lineups.php';
const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1';
const MLB_GAME_FEED_BASE = 'https://statsapi.mlb.com/api/v1.1';
const MLB_POWER_RANKINGS_URL = 'https://www.mlb.com/news/mlb-power-rankings-inaugural-2026-edition';
const SPORTS_INSIGHTS_MLB_EVENTS_URL = 'https://account.sportsinsights.com/wp/api/events/sport/3';
const BALLDONTLIE_API_BASE = 'https://api.balldontlie.io/mlb/v1';
const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY || '';
const cheerio = require('cheerio');
const path = require('path');
const { execFileSync } = require('child_process');

const WORKBOOK_PATH =
  process.env.MLB_MODEL_WORKBOOK_PATH || '/Users/brianpierce/Downloads/MLB Model V1 2026.xlsm';

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function mapWeatherCondition(summary = '', stadiumTypeDisplay = '') {
  const normalized = normalizeName(summary);
  const stadium = normalizeName(stadiumTypeDisplay);

  if (stadium.includes('dome') || stadium.includes('roof closed')) {
    return 'dome';
  }
  if (normalized.includes('rain') || normalized.includes('storm') || normalized.includes('showers')) {
    return 'rain';
  }
  if (normalized.includes('humid')) {
    return 'humid';
  }
  if (normalized.includes('cloud')) {
    return 'cloudy';
  }
  return 'clear';
}

function mapWindDirection(adjWindBearing) {
  const bearing = Number(adjWindBearing);
  if (!Number.isFinite(bearing)) {
    return 'neutral';
  }

  const normalized = ((bearing % 360) + 360) % 360;
  if (normalized <= 35 || normalized >= 325) {
    return 'out';
  }
  if (normalized >= 145 && normalized <= 215) {
    return 'in';
  }
  return 'cross';
}

function buildSportsInsightsWeather(event) {
  const gameTimeWeather =
    event?.WeatherItems?.find((item) => item?.IsGameTime) ||
    event?.Weather ||
    event?.WeatherItems?.[0] ||
    null;

  if (!gameTimeWeather) {
    return null;
  }

  return {
    source: 'Sports Insights',
    sourceUrl: 'https://www.sportsinsights.com/mlb/weather/',
    summary: cleanText(gameTimeWeather.Summary),
    temperature: Math.round(Number(gameTimeWeather.Temperature)),
    windMph: Math.round(Number(gameTimeWeather.WindSpeed)),
    windDirection: mapWindDirection(gameTimeWeather.AdjWindBearing),
    condition: mapWeatherCondition(gameTimeWeather.Summary, event?.Venue?.StadiumTypeDisplay),
    venue: cleanText(event?.Venue?.VenueName || event?.StadiumName),
    raw: {
      adjWindBearing: Number(gameTimeWeather.AdjWindBearing),
      stadiumTypeDisplay: cleanText(event?.Venue?.StadiumTypeDisplay),
      weatherTime: gameTimeWeather.WeatherTime,
    },
  };
}

function matchesSportsInsightsEvent(event, awayTeam, homeTeam, date) {
  const awayMatch = normalizeName(event?.VisitorTeam) === normalizeName(awayTeam);
  const homeMatch = normalizeName(event?.HomeTeam) === normalizeName(homeTeam);
  const eventDate = String(event?.EventDateTime || '').slice(0, 10);
  return awayMatch && homeMatch && (!date || eventDate === date);
}

const POWER_RANKING_NAME_TO_ABBREVIATION = {
  Dodgers: 'LAD',
  'Blue Jays': 'TOR',
  Mariners: 'SEA',
  Phillies: 'PHI',
  'Red Sox': 'BOS',
  Brewers: 'MIL',
  Yankees: 'NYY',
  Mets: 'NYM',
  Orioles: 'BAL',
  Cubs: 'CHC',
  Braves: 'ATL',
  Padres: 'SD',
  Tigers: 'DET',
  Astros: 'HOU',
  Diamondbacks: 'ARI',
  Royals: 'KC',
  Reds: 'CIN',
  Athletics: 'ATH',
  Giants: 'SF',
  Rangers: 'TEX',
  Guardians: 'CLE',
  Rays: 'TB',
  Pirates: 'PIT',
  Marlins: 'MIA',
  Twins: 'MIN',
  'White Sox': 'CWS',
  Cardinals: 'STL',
  Nationals: 'WSH',
  Angels: 'LAA',
  Rockies: 'COL',
};

function buildFallbackLineups() {
  const scriptPath = path.resolve(__dirname, '../scripts/extract_workbook_data.py');
  const output = execFileSync('python3', [scriptPath, WORKBOOK_PATH], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

function collectMatches(source, expression, group = 1) {
  const matches = [];
  let match = expression.exec(source);

  while (match) {
    matches.push(cleanText(match[group]));
    match = expression.exec(source);
  }

  return matches.filter(Boolean);
}

function parsePowerRankings(html) {
  const text = cleanText(html);
  const matches = [...text.matchAll(/(?:^|\s)(\d{1,2})\.\s+([A-Za-z.\-'\s]+?)\s+\(\d{1,2}\)/g)];
  const teams = matches
    .map((match) => {
      const rank = Number(match[1]);
      const name = cleanText(match[2]);
      const abbreviation = POWER_RANKING_NAME_TO_ABBREVIATION[name];

      if (!Number.isFinite(rank) || !abbreviation) {
        return null;
      }

      return {
        rank,
        name,
        abbreviation,
      };
    })
    .filter(Boolean)
    .slice(0, 30);

  return teams;
}

function parseTeamCodes(block) {
  const candidates = [
    ...collectMatches(block, /data-team-code="([^"]+)"/g),
    ...collectMatches(block, /lineup__abbr[^>]*>([^<]+)</g),
    ...collectMatches(block, /lineup__team-abbrev[^>]*>([^<]+)</g),
  ].filter((value) => value.length <= 4);

  return {
    awayAbbreviation: candidates[0] || '',
    homeAbbreviation: candidates[1] || '',
  };
}

function parseLineupNames(block) {
  const names = [
    ...collectMatches(
      block,
      /<li[^>]+class="[^"]*lineup__player[^"]*"[\s\S]*?<a[^>]+title="([^"]+)"/g
    ),
    ...collectMatches(
      block,
      /<li[^>]+class="[^"]*lineup__player[^"]*"[\s\S]*?<a[^>]*>([^<]+)<\/a>/g
    ),
    ...collectMatches(block, /lineup__player-highlight-name[^>]*>([^<]+)</g),
    ...collectMatches(block, /lineup__player-name[^>]*>([^<]+)</g),
    ...collectMatches(block, /data-rotowire-player-name="([^"]+)"/g),
  ];

  const unique = [];
  names.forEach((name) => {
    if (name && !unique.includes(name)) {
      unique.push(name);
    }
  });

  return unique.slice(0, 9).map((name, index) => ({ slot: index + 1, name }));
}

function splitGameBlocks(html) {
  const blocks = html.match(/<div[^>]+class="[^"]*(?:lineup__box|lineup is-mlb|lineup)[^"]*"[\s\S]*?<\/div>\s*<\/div>/g);
  return blocks || [];
}

function extractGamesFromHtml(html) {
  const $ = cheerio.load(html);

  return $('.lineup.is-mlb')
    .toArray()
    .map((element) => {
      const game = $(element);
      if (game.hasClass('is-tools')) {
        return null;
      }

      const awayAbbreviation = cleanText(
        game.find('.lineup__team.is-visit .lineup__abbr').first().text()
      ).toUpperCase();
      const homeAbbreviation = cleanText(
        game.find('.lineup__team.is-home .lineup__abbr').first().text()
      ).toUpperCase();

      const awayLineupNames = game
        .find('.lineup__list.is-visit li.lineup__player a')
        .map((_, link) => cleanText($(link).attr('title') || $(link).text()))
        .get()
        .filter(Boolean)
        .slice(0, 9);
      const homeLineupNames = game
        .find('.lineup__list.is-home li.lineup__player a')
        .map((_, link) => cleanText($(link).attr('title') || $(link).text()))
        .get()
        .filter(Boolean)
        .slice(0, 9);

      return {
        awayAbbreviation,
        homeAbbreviation,
        awayLineup: awayLineupNames.map((name, index) => ({ slot: index + 1, name })),
        homeLineup: homeLineupNames.map((name, index) => ({ slot: index + 1, name })),
      };
    })
    .filter(Boolean)
    .filter((game) => game.awayAbbreviation && game.homeAbbreviation && (game.awayLineup.length || game.homeLineup.length));
}

function extractPitchingStrikeouts(player) {
  return Number(player?.stats?.pitching?.strikeOuts ?? player?.stats?.pitching?.strikeouts ?? NaN);
}

function extractPitchingBattersFaced(player) {
  return Number(player?.stats?.pitching?.battersFaced ?? NaN);
}

function extractPitchingInningsPitched(player) {
  const inningsPitched = player?.stats?.pitching?.inningsPitched;
  return inningsPitched == null || inningsPitched === '' ? '' : String(inningsPitched);
}

function findStarterBoxscoreLine(teamBoxscore, probablePitcherId) {
  const players = Object.values(teamBoxscore?.players || {});
  if (!players.length) {
    return null;
  }

  const gamesStartedStarter = players.find(
    (player) =>
      Number(player?.stats?.pitching?.gamesStarted ?? 0) > 0 &&
      (Number.isFinite(extractPitchingStrikeouts(player)) || extractPitchingInningsPitched(player))
  );
  if (gamesStartedStarter) {
    return gamesStartedStarter;
  }

  const probableStarter = probablePitcherId
    ? players.find((player) => Number(player?.person?.id) === Number(probablePitcherId))
    : null;
  if (
    probableStarter &&
    (Number.isFinite(extractPitchingStrikeouts(probableStarter)) ||
      extractPitchingInningsPitched(probableStarter))
  ) {
    return probableStarter;
  }

  return players.find((player) => Number.isFinite(extractPitchingStrikeouts(player))) || null;
}

function isCompletedGame(game) {
  const state = String(game?.status?.abstractGameState || '').toLowerCase();
  const detailed = String(game?.status?.detailedState || '').toLowerCase();
  const coded = String(game?.status?.codedGameState || '');
  const awayScore = game?.teams?.away?.score;
  const homeScore = game?.teams?.home?.score;

  return (
    state === 'final' ||
    state === 'completed early' ||
    detailed.includes('final') ||
    detailed.includes('completed') ||
    coded === 'F' ||
    coded === 'O' ||
    (Number.isFinite(Number(awayScore)) && Number.isFinite(Number(homeScore)))
  );
}

function buildFallbackGameResult(game) {
  return {
    gamePk: game.gamePk,
    gameDate: game.gameDate,
    status: game?.status?.detailedState || 'Final',
    venue: game?.venue?.name || '',
    awayTeam: {
      abbreviation:
        game?.teams?.away?.team?.abbreviation ||
        game?.teams?.away?.team?.teamCode?.toUpperCase() ||
        'AWY',
      name: game?.teams?.away?.team?.name || 'Away Team',
      score: Number(game?.teams?.away?.score ?? 0),
      starterName: game?.teams?.away?.probablePitcher?.fullName || '',
      starterStrikeouts: null,
      starterInningsPitched: '',
      starterBattersFaced: null,
    },
    homeTeam: {
      abbreviation:
        game?.teams?.home?.team?.abbreviation ||
        game?.teams?.home?.team?.teamCode?.toUpperCase() ||
        'HME',
      name: game?.teams?.home?.team?.name || 'Home Team',
      score: Number(game?.teams?.home?.score ?? 0),
      starterName: game?.teams?.home?.probablePitcher?.fullName || '',
      starterStrikeouts: null,
      starterInningsPitched: '',
      starterBattersFaced: null,
    },
  };
}

let cachedBallDontLieTeams = null;

async function fetchBallDontLieJson(pathname, params = {}) {
  if (!BALLDONTLIE_API_KEY) {
    throw new Error('Missing BALLDONTLIE_API_KEY');
  }

  const url = new URL(`${BALLDONTLIE_API_BASE}${pathname}`);
  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item != null && item !== '') {
          url.searchParams.append(key, String(item));
        }
      });
      return;
    }

    if (value != null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 Codex MLB Model App',
      Authorization: BALLDONTLIE_API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(`Ball Don't Lie request failed with status ${response.status}`);
  }

  return response.json();
}

async function getBallDontLieTeams() {
  if (cachedBallDontLieTeams) {
    return cachedBallDontLieTeams;
  }

  const response = await fetchBallDontLieJson('/teams');
  cachedBallDontLieTeams = response?.data || [];
  return cachedBallDontLieTeams;
}

async function getBallDontLieTeamIdsByAbbreviation(abbreviations = []) {
  const teams = await getBallDontLieTeams();
  const wanted = new Set(abbreviations.map((value) => String(value || '').toUpperCase()));
  return teams
    .filter((team) => wanted.has(String(team?.abbreviation || '').toUpperCase()))
    .map((team) => ({
      abbreviation: String(team.abbreviation || '').toUpperCase(),
      id: team.id,
    }));
}

function isOutStatus(injury) {
  const statusText = normalizeName(
    `${injury?.status || ''} ${injury?.type || ''} ${injury?.short_comment || ''} ${injury?.detail || ''}`
  );

  return (
    statusText.includes('out') ||
    statusText.includes('injured list') ||
    statusText.includes('il') ||
    statusText.includes('60 day') ||
    statusText.includes('15 day') ||
    statusText.includes('10 day')
  );
}

async function fetchCompletedGameResult(game) {
  try {
    const liveFeed = await fetchJson(`${MLB_GAME_FEED_BASE}/game/${game.gamePk}/feed/live`);
    const awayBoxscore = liveFeed?.liveData?.boxscore?.teams?.away;
    const homeBoxscore = liveFeed?.liveData?.boxscore?.teams?.home;
    const awayStarter = findStarterBoxscoreLine(
      awayBoxscore,
      game?.teams?.away?.probablePitcher?.id
    );
    const homeStarter = findStarterBoxscoreLine(
      homeBoxscore,
      game?.teams?.home?.probablePitcher?.id
    );
    const linescore = liveFeed?.liveData?.linescore;

    return {
      gamePk: game.gamePk,
      gameDate: game.gameDate,
      status:
        liveFeed?.gameData?.status?.detailedState ||
        game?.status?.detailedState ||
        'Final',
      venue: game?.venue?.name || liveFeed?.gameData?.venue?.name || '',
      awayTeam: {
        abbreviation:
          game?.teams?.away?.team?.abbreviation ||
          liveFeed?.gameData?.teams?.away?.abbreviation ||
          game?.teams?.away?.team?.teamCode?.toUpperCase() ||
          'AWY',
        name:
          game?.teams?.away?.team?.name ||
          liveFeed?.gameData?.teams?.away?.name ||
          'Away Team',
        score: Number(linescore?.teams?.away?.runs ?? game?.teams?.away?.score ?? 0),
        starterName:
          awayStarter?.person?.fullName ||
          game?.teams?.away?.probablePitcher?.fullName ||
          '',
        starterStrikeouts: Number.isFinite(extractPitchingStrikeouts(awayStarter))
          ? extractPitchingStrikeouts(awayStarter)
          : null,
        starterInningsPitched: extractPitchingInningsPitched(awayStarter),
        starterBattersFaced: Number.isFinite(extractPitchingBattersFaced(awayStarter))
          ? extractPitchingBattersFaced(awayStarter)
          : null,
      },
      homeTeam: {
        abbreviation:
          game?.teams?.home?.team?.abbreviation ||
          liveFeed?.gameData?.teams?.home?.abbreviation ||
          game?.teams?.home?.team?.teamCode?.toUpperCase() ||
          'HME',
        name:
          game?.teams?.home?.team?.name ||
          liveFeed?.gameData?.teams?.home?.name ||
          'Home Team',
        score: Number(linescore?.teams?.home?.runs ?? game?.teams?.home?.score ?? 0),
        starterName:
          homeStarter?.person?.fullName ||
          game?.teams?.home?.probablePitcher?.fullName ||
          '',
        starterStrikeouts: Number.isFinite(extractPitchingStrikeouts(homeStarter))
          ? extractPitchingStrikeouts(homeStarter)
          : null,
        starterInningsPitched: extractPitchingInningsPitched(homeStarter),
        starterBattersFaced: Number.isFinite(extractPitchingBattersFaced(homeStarter))
          ? extractPitchingBattersFaced(homeStarter)
          : null,
      },
    };
  } catch (error) {
    return buildFallbackGameResult(game);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 Codex MLB Model App',
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url} with status ${response.status}`);
  }

  return response.json();
}

async function fetchResultsByDate(date) {
  const schedule = await fetchJson(
    `${MLB_API_BASE}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team,linescore`
  );
  const games = schedule?.dates?.[0]?.games || [];
  const completedGames = games.filter(isCompletedGame);
  return Promise.all(completedGames.map(fetchCompletedGameResult));
}

async function fetchPitcherLastOuting(pitcherId, beforeDate) {
  const targetDate = new Date(`${beforeDate}T00:00:00Z`);
  const year = Number(String(beforeDate || '').slice(0, 4)) || new Date().getUTCFullYear();
  const seasons = Array.from(new Set([year, year - 1])).filter(Number.isFinite);
  const allSplits = [];

  for (const season of seasons) {
    const stats = await fetchJson(
      `${MLB_API_BASE}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`
    );
    const splits = stats?.stats?.[0]?.splits || [];
    allSplits.push(...splits);
  }

  const outings = allSplits
    .map((split) => ({
      date: split?.date,
      opponent: split?.opponent?.name || '',
      strikeouts: Number(split?.stat?.strikeOuts ?? split?.stat?.strikeouts ?? NaN),
    }))
    .filter(
      (outing) =>
        outing.date &&
        Number.isFinite(outing.strikeouts) &&
        new Date(`${outing.date}T00:00:00Z`).getTime() < targetDate.getTime()
    )
    .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime());

  return outings[0] || null;
}

module.exports = function setupProxy(app) {
  app.get('/api/fallback-lineups', async (_req, res) => {
    try {
      const workbookData = buildFallbackLineups();
      res.json({
        lineups: workbookData.lineups || {},
      });
    } catch (error) {
      res.status(500).json({
        lineups: {},
      });
    }
  });

  app.get('/api/workbook-model-data', async (_req, res) => {
    try {
      res.json(buildFallbackLineups());
    } catch (error) {
      res.status(500).json({
        lineups: {},
        lineupValues: {},
        params: {},
        pitchers: {},
        teamObp: {},
        teamKVsR: {},
        teamKVsL: {},
        venueFactors: {},
        bullpenFipByTeam: {},
      });
    }
  });

  app.get('/api/rotowire/lineups', async (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    try {
      const url = `${ROTOWIRE_URL}?date=${date}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 Codex MLB Model App',
        },
      });

      if (!response.ok) {
        res.status(502).json({
          games: [],
          error: `RotoWire request failed with status ${response.status}.`,
        });
        return;
      }

      const html = await response.text();
      const games = extractGamesFromHtml(html);

      res.json({
        games,
        error: games.length ? '' : 'RotoWire responded, but no posted lineups were parsed for this date yet.',
      });
    } catch (error) {
      res.status(502).json({
        games: [],
        error: 'RotoWire proxy could not retrieve lineups from the remote source.',
      });
    }
  });

  app.get('/api/mlb/results', async (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    try {
      const games = await fetchResultsByDate(date);
      res.json({
        games,
        error: '',
      });
    } catch (error) {
      res.status(502).json({
        games: [],
        error: 'Unable to retrieve completed MLB results for this date.',
      });
    }
  });

  app.get('/api/mlb/pitcher-last-outing', async (req, res) => {
    const pitcherId = Number(req.query.pitcherId);
    const beforeDate = String(req.query.before || new Date().toISOString().slice(0, 10));

    if (!Number.isFinite(pitcherId) || pitcherId <= 0) {
      res.status(400).json({
        outing: null,
        error: 'A valid pitcherId is required.',
      });
      return;
    }

    try {
      const outing = await fetchPitcherLastOuting(pitcherId, beforeDate);
      res.json({
        outing,
        error: outing ? '' : 'No prior outing was found before this game date.',
      });
    } catch (error) {
      res.status(502).json({
        outing: null,
        error: 'Unable to retrieve the pitcher game log from MLB Stats API.',
      });
    }
  });

  app.get('/api/mlb/power-rankings', async (_req, res) => {
    try {
      const response = await fetch(MLB_POWER_RANKINGS_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 Codex MLB Model App',
        },
      });

      if (!response.ok) {
        res.status(502).json({
          rankings: [],
          source: MLB_POWER_RANKINGS_URL,
          error: `MLB.com power rankings request failed with status ${response.status}.`,
        });
        return;
      }

      const html = await response.text();
      const rankings = parsePowerRankings(html);

      res.json({
        rankings,
        source: MLB_POWER_RANKINGS_URL,
        error: rankings.length ? '' : 'MLB.com responded, but no power rankings were parsed from the article.',
      });
    } catch (error) {
      res.status(502).json({
        rankings: [],
        source: MLB_POWER_RANKINGS_URL,
        error: 'Unable to retrieve MLB.com power rankings right now.',
      });
    }
  });

  app.get('/api/mlb/weather', async (req, res) => {
    const awayTeam = String(req.query.awayTeam || '');
    const homeTeam = String(req.query.homeTeam || '');
    const date = String(req.query.date || '');

    if (!awayTeam || !homeTeam) {
      res.status(400).json({
        weather: null,
        error: 'awayTeam and homeTeam are required.',
      });
      return;
    }

    try {
      const response = await fetch(SPORTS_INSIGHTS_MLB_EVENTS_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 Codex MLB Model App',
        },
      });

      if (!response.ok) {
        res.status(502).json({
          weather: null,
          error: `Sports Insights request failed with status ${response.status}.`,
        });
        return;
      }

      const events = await response.json();
      const matchingEvent = (events || []).find((event) =>
        matchesSportsInsightsEvent(event, awayTeam, homeTeam, date)
      );

      if (!matchingEvent) {
        res.json({
          weather: null,
          error: 'No Sports Insights weather matchup was found for this game.',
        });
        return;
      }

      res.json({
        weather: buildSportsInsightsWeather(matchingEvent),
        error: '',
      });
    } catch (error) {
      res.status(502).json({
        weather: null,
        error: 'Unable to retrieve Sports Insights weather right now.',
      });
    }
  });

  app.get('/api/balldontlie/lineup-injuries', async (req, res) => {
    const abbreviations = String(req.query.teams || '')
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);

    if (!abbreviations.length) {
      res.status(400).json({
        injuriesByTeam: {},
        error: 'At least one team abbreviation is required.',
      });
      return;
    }

    try {
      const teamMappings = await getBallDontLieTeamIdsByAbbreviation(abbreviations);
      if (!teamMappings.length) {
        res.json({
          injuriesByTeam: {},
          error: 'No Ball Don’t Lie team mapping was found for these clubs.',
        });
        return;
      }

      const injuryResponse = await fetchBallDontLieJson('/player_injuries', {
        'team_ids[]': teamMappings.map((team) => team.id),
        per_page: 100,
      });

      const abbreviationByTeamId = Object.fromEntries(
        teamMappings.map((team) => [team.id, team.abbreviation])
      );
      const injuriesByTeam = {};

      (injuryResponse?.data || []).forEach((injury) => {
        const teamId = injury?.player?.team?.id;
        const abbreviation = abbreviationByTeamId[teamId];
        if (!abbreviation || !isOutStatus(injury)) {
          return;
        }

        const playerName = cleanText(
          injury?.player?.full_name ||
          `${injury?.player?.first_name || ''} ${injury?.player?.last_name || ''}`
        );
        if (!playerName) {
          return;
        }

        if (!injuriesByTeam[abbreviation]) {
          injuriesByTeam[abbreviation] = [];
        }

        injuriesByTeam[abbreviation].push({
          playerName,
          status: cleanText(injury?.status),
          detail: cleanText(injury?.detail || injury?.short_comment || injury?.long_comment),
          returnDate: injury?.return_date || '',
        });
      });

      res.json({
        injuriesByTeam,
        error: '',
      });
    } catch (error) {
      res.status(502).json({
        injuriesByTeam: {},
        error: 'Unable to retrieve Ball Don’t Lie lineup injuries right now.',
      });
    }
  });
};
