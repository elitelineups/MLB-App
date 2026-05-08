import { useEffect, useMemo, useState } from 'react';
import './App.css';
import modelData from './modelData.json';
import {
  buildGameStateFromSelection,
  buildTeamOptions,
  createEmptyGameState,
  defaultDateString,
  findRotowireMatchup,
  formatGameLabel,
  getFallbackLineupForHand,
  hasLineupMismatch,
  normalizeLineupFromPosted,
  createLineupFromWorkbookEntries,
  createLineupFromNames,
  normalizeNameKey,
  updateTeamFromAbbreviation,
} from './utils/mlb';
import {
  fetchFinalResultsByDate,
  fetchFallbackLineups,
  fetchLineupInjuries,
  fetchPowerRankings,
  fetchPitcherLastOuting,
  fetchRotowireLineups,
  fetchScheduleByDate,
  fetchSportsInsightsWeather,
  fetchWorkbookModelData,
} from './utils/api';
import { calculateProjections, formatDecimalOdds, formatRuns } from './utils/model';
import { downloadProjectionWorkbook } from './utils/export';
import ProjectionResults from './components/ProjectionResults';
import TeamBadge from './components/TeamBadge';
import TeamEditor from './components/TeamEditor';

function isValidDateString(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    return false;
  }

  const parsed = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime());
}

function previousDateString(date, daysBack) {
  if (!isValidDateString(date)) {
    return '';
  }

  const baseDate = new Date(`${date}T12:00:00Z`);
  baseDate.setUTCDate(baseDate.getUTCDate() - daysBack);
  return baseDate.toISOString().slice(0, 10);
}

function formatResultDate(date) {
  if (!isValidDateString(date)) {
    return date || 'Invalid date';
  }

  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'America/New_York',
    }).format(new Date(`${date}T12:00:00Z`));
  } catch (error) {
    return date;
  }
}

function buildTeamStrengthSeed(teams) {
  return Object.fromEntries(
    [...(teams || [])].map((team) => [team.abbreviation, Number(team.offenseRating) || 100])
  );
}

const TEAM_STRENGTH_STORAGE_VERSION = '2026-03-21';
const BUILD_STYLE_STORAGE_KEY = 'mlbModelBuildStyle';
const BUILD_STYLE_OPTIONS = [
  { value: 'high_projection', label: 'High Projection' },
  { value: 'contrarian', label: 'Contrarian' },
];

function readSavedTeamStrengths(storageKey) {
  try {
    const savedVersion = window.localStorage.getItem('mlbModelTeamStrengthsVersion');
    if (savedVersion !== TEAM_STRENGTH_STORAGE_VERSION) {
      return null;
    }

    return JSON.parse(window.localStorage.getItem(storageKey) || 'null');
  } catch (error) {
    return null;
  }
}

function sortTeamsByStrength(teams, strengthRatings) {
  return [...(teams || [])].sort((left, right) => {
    const leftStrength = Number(strengthRatings[left.abbreviation] ?? left.offenseRating ?? 100);
    const rightStrength = Number(strengthRatings[right.abbreviation] ?? right.offenseRating ?? 100);
    return rightStrength - leftStrength || left.abbreviation.localeCompare(right.abbreviation);
  });
}

function lineupSignature(lineup) {
  return JSON.stringify(
    (lineup || []).map((player) => ({
      slot: Number(player.slot),
      name: String(player.name || ''),
      rating: Number(player.rating),
      manualName: Boolean(player.manualName),
      manualRating: Boolean(player.manualRating),
      manualSlot: Boolean(player.manualSlot),
    }))
  );
}

function mergeLineupWithSource(currentLineup, sourceLineup) {
  if (!sourceLineup?.length) {
    return currentLineup;
  }

  return sourceLineup.map((sourcePlayer, index) => {
    const currentPlayer = currentLineup?.[index];
    if (!currentPlayer) {
      return sourcePlayer;
    }

    return {
      ...sourcePlayer,
      slot: currentPlayer.manualSlot ? currentPlayer.slot : sourcePlayer.slot,
      name: currentPlayer.manualName ? currentPlayer.name : sourcePlayer.name,
      rating: currentPlayer.manualRating ? currentPlayer.rating : sourcePlayer.rating,
      manualName: Boolean(currentPlayer.manualName),
      manualRating: Boolean(currentPlayer.manualRating),
      manualSlot: Boolean(currentPlayer.manualSlot),
    };
  });
}

function buildUnavailablePlayerMatcher(injuries = []) {
  const fullNameKeys = new Set();
  const lastNameKeys = new Set();
  const initialLastKeys = new Set();

  (injuries || []).forEach((injury) => {
    const normalizedName = normalizeNameKey(injury?.playerName);
    if (!normalizedName) {
      return;
    }

    fullNameKeys.add(normalizedName);

    const parts = normalizedName.split(' ').filter(Boolean);
    if (!parts.length) {
      return;
    }

    const lastName = parts[parts.length - 1];
    if (lastName) {
      lastNameKeys.add(lastName);
      if (parts[0]) {
        initialLastKeys.add(`${parts[0].charAt(0)} ${lastName}`);
      }
    }
  });

  return {
    fullNameKeys,
    lastNameKeys,
    initialLastKeys,
  };
}

function isUnavailablePlayerName(name, unavailablePlayerMatcher) {
  const normalizedName = normalizeNameKey(name);
  if (!normalizedName) {
    return false;
  }

  if (unavailablePlayerMatcher.fullNameKeys.has(normalizedName)) {
    return true;
  }

  const parts = normalizedName.split(' ').filter(Boolean);
  if (!parts.length) {
    return false;
  }

  const lastName = parts[parts.length - 1];
  if (unavailablePlayerMatcher.lastNameKeys.has(lastName)) {
    return true;
  }

  const first = parts[0];
  if (!first) {
    return false;
  }

  return unavailablePlayerMatcher.initialLastKeys.has(`${first.charAt(0)} ${lastName}`);
}

function filterNamesByAvailability(names = [], unavailablePlayerMatcher) {
  return (names || []).filter((name) => !isUnavailablePlayerName(name, unavailablePlayerMatcher));
}

function filterEntriesByAvailability(entries = [], unavailablePlayerMatcher) {
  return (entries || []).filter((entry) => !isUnavailablePlayerName(entry?.name, unavailablePlayerMatcher));
}

function filterPostedLineupByAvailability(postedLineup = [], unavailablePlayerMatcher) {
  return (postedLineup || []).filter((player) => !isUnavailablePlayerName(player?.name, unavailablePlayerMatcher));
}

function App() {
  const savedSeedStrengths = readSavedTeamStrengths('mlbModelSeedTeamStrengths');
  const savedCurrentStrengths = readSavedTeamStrengths('mlbModelCurrentTeamStrengths');
  const [selectedDate, setSelectedDate] = useState(defaultDateString());
  const [activeTab, setActiveTab] = useState('model');
  const [seedTeamStrengthRatings, setSeedTeamStrengthRatings] = useState(
    () => savedSeedStrengths || buildTeamStrengthSeed(modelData.teams)
  );
  const [teamStrengthRatings, setTeamStrengthRatings] = useState(
    () => savedCurrentStrengths || savedSeedStrengths || buildTeamStrengthSeed(modelData.teams)
  );
  const [buildStyle, setBuildStyle] = useState(() => {
    const savedStyle = window.localStorage.getItem(BUILD_STYLE_STORAGE_KEY);
    return savedStyle === 'contrarian' ? 'contrarian' : 'high_projection';
  });
  const [rankingsStatus, setRankingsStatus] = useState({ loading: false, error: '' });
  const [rankingsSource, setRankingsSource] = useState('');
  const [games, setGames] = useState([]);
  const [selectedGamePk, setSelectedGamePk] = useState('');
  const [gameState, setGameState] = useState(createEmptyGameState(modelData));
  const [scheduleStatus, setScheduleStatus] = useState({ loading: false, error: '' });
  const [rotowireStatus, setRotowireStatus] = useState({ loading: false, error: '' });
  const [resultsStatus, setResultsStatus] = useState({ loading: false, error: '' });
  const [weatherStatus, setWeatherStatus] = useState({ loading: false, error: '', source: '' });
  const [injuryStatus, setInjuryStatus] = useState({ loading: false, error: '' });
  const [injuriesByTeam, setInjuriesByTeam] = useState({});
  const [postedLineups, setPostedLineups] = useState([]);
  const [finalResults, setFinalResults] = useState([]);
  const [recentResults, setRecentResults] = useState([]);
  const [fallbackLineups, setFallbackLineups] = useState({});
  const [workbookModelData, setWorkbookModelData] = useState({
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
  const combinedLineups = useMemo(
    () =>
      Object.keys(fallbackLineups || {}).length
        ? fallbackLineups
        : workbookModelData.lineups || {},
    [fallbackLineups, workbookModelData.lineups]
  );

  const teamOptions = useMemo(() => buildTeamOptions(modelData), []);
  const selectedGame = useMemo(
    () => games.find((game) => String(game.gamePk) === String(selectedGamePk)) || null,
    [games, selectedGamePk]
  );
  const awayUnavailablePlayerMatcher = useMemo(
    () => buildUnavailablePlayerMatcher(injuriesByTeam[gameState.awayTeam.abbreviation] || []),
    [injuriesByTeam, gameState.awayTeam.abbreviation]
  );
  const homeUnavailablePlayerMatcher = useMemo(
    () => buildUnavailablePlayerMatcher(injuriesByTeam[gameState.homeTeam.abbreviation] || []),
    [injuriesByTeam, gameState.homeTeam.abbreviation]
  );
  const rotowireMatchup = useMemo(
    () => findRotowireMatchup(postedLineups, gameState.awayTeam.abbreviation, gameState.homeTeam.abbreviation),
    [postedLineups, gameState.awayTeam.abbreviation, gameState.homeTeam.abbreviation]
  );
  const awayPostedLineup = useMemo(
    () => filterPostedLineupByAvailability(rotowireMatchup?.awayLineup || [], awayUnavailablePlayerMatcher),
    [rotowireMatchup, awayUnavailablePlayerMatcher]
  );
  const homePostedLineup = useMemo(
    () => filterPostedLineupByAvailability(rotowireMatchup?.homeLineup || [], homeUnavailablePlayerMatcher),
    [rotowireMatchup, homeUnavailablePlayerMatcher]
  );
  const awaySheetLineupEntries = useMemo(
    () =>
      filterEntriesByAvailability(
        getFallbackLineupForHand(
          workbookModelData.lineupValues || {},
          gameState.awayTeam.abbreviation,
          gameState.homeTeam.probablePitcher.hand
        ),
        awayUnavailablePlayerMatcher
      ),
    [
      workbookModelData.lineupValues,
      gameState.awayTeam.abbreviation,
      gameState.homeTeam.probablePitcher.hand,
      awayUnavailablePlayerMatcher,
    ]
  );
  const homeSheetLineupEntries = useMemo(
    () =>
      filterEntriesByAvailability(
        getFallbackLineupForHand(
          workbookModelData.lineupValues || {},
          gameState.homeTeam.abbreviation,
          gameState.awayTeam.probablePitcher.hand
        ),
        homeUnavailablePlayerMatcher
      ),
    [
      workbookModelData.lineupValues,
      gameState.homeTeam.abbreviation,
      gameState.awayTeam.probablePitcher.hand,
      homeUnavailablePlayerMatcher,
    ]
  );
  const awaySheetLineupNames = useMemo(
    () =>
      filterNamesByAvailability(
        getFallbackLineupForHand(
          combinedLineups,
          gameState.awayTeam.abbreviation,
          gameState.homeTeam.probablePitcher.hand
        ),
        awayUnavailablePlayerMatcher
      ),
    [
      combinedLineups,
      gameState.awayTeam.abbreviation,
      gameState.homeTeam.probablePitcher.hand,
      awayUnavailablePlayerMatcher,
    ]
  );
  const homeSheetLineupNames = useMemo(
    () =>
      filterNamesByAvailability(
        getFallbackLineupForHand(
          combinedLineups,
          gameState.homeTeam.abbreviation,
          gameState.awayTeam.probablePitcher.hand
        ),
        homeUnavailablePlayerMatcher
      ),
    [
      combinedLineups,
      gameState.homeTeam.abbreviation,
      gameState.awayTeam.probablePitcher.hand,
      homeUnavailablePlayerMatcher,
    ]
  );
  const awaySheetLineup = useMemo(
    () => (
      buildStyle === 'high_projection' && awaySheetLineupEntries.length
        ? createLineupFromWorkbookEntries(
            gameState.awayTeam.name,
            modelData.defaultHitterRatingsBySpot,
            awaySheetLineupEntries
          )
        : createLineupFromNames(
            gameState.awayTeam.name,
            modelData.defaultHitterRatingsBySpot,
            awaySheetLineupNames
          )
    ),
    [buildStyle, awaySheetLineupEntries, awaySheetLineupNames, gameState.awayTeam.name]
  );
  const homeSheetLineup = useMemo(
    () => (
      buildStyle === 'high_projection' && homeSheetLineupEntries.length
        ? createLineupFromWorkbookEntries(
            gameState.homeTeam.name,
            modelData.defaultHitterRatingsBySpot,
            homeSheetLineupEntries
          )
        : createLineupFromNames(
            gameState.homeTeam.name,
            modelData.defaultHitterRatingsBySpot,
            homeSheetLineupNames
          )
    ),
    [buildStyle, homeSheetLineupEntries, homeSheetLineupNames, gameState.homeTeam.name]
  );
  const projections = useMemo(() => calculateProjections(gameState), [gameState]);
  const awayPitcherMlbamId = gameState.awayTeam.probablePitcher.mlbamId;
  const homePitcherMlbamId = gameState.homeTeam.probablePitcher.mlbamId;
  const awayBatterOptions = useMemo(
    () =>
      awaySheetLineupEntries
        .map((entry) => entry?.name)
        .filter(Boolean),
    [awaySheetLineupEntries]
  );
  const homeBatterOptions = useMemo(
    () =>
      homeSheetLineupEntries
        .map((entry) => entry?.name)
        .filter(Boolean),
    [homeSheetLineupEntries]
  );
  const pitcherOptions = useMemo(
    () =>
      Object.values(workbookModelData.pitchers || {})
        .map((pitcher) => pitcher.name)
        .filter(Boolean)
        .filter((name, index, values) => values.indexOf(name) === index)
        .sort((left, right) => left.localeCompare(right)),
    [workbookModelData.pitchers]
  );
  const awayWorkbookPitcher = useMemo(
    () => workbookModelData.pitchers[normalizeNameKey(gameState.awayTeam.probablePitcher.name)],
    [workbookModelData.pitchers, gameState.awayTeam.probablePitcher.name]
  );
  const homeWorkbookPitcher = useMemo(
    () => workbookModelData.pitchers[normalizeNameKey(gameState.homeTeam.probablePitcher.name)],
    [workbookModelData.pitchers, gameState.homeTeam.probablePitcher.name]
  );
  const awayWorkbookStarterFipActive = Number.isFinite(Number(awayWorkbookPitcher?.fip));
  const homeWorkbookStarterFipActive = Number.isFinite(Number(homeWorkbookPitcher?.fip));
  const awayWorkbookBullpenFipActive = Number.isFinite(
    Number(workbookModelData.bullpenFipByTeam?.[gameState.awayTeam.abbreviation])
  );
  const homeWorkbookBullpenFipActive = Number.isFinite(
    Number(workbookModelData.bullpenFipByTeam?.[gameState.homeTeam.abbreviation])
  );

  useEffect(() => {
    let ignore = false;

    async function loadSchedule() {
      setScheduleStatus({ loading: true, error: '' });

      try {
        const nextGames = await fetchScheduleByDate(selectedDate);
        if (ignore) {
          return;
        }

        setGames(nextGames);
        if (nextGames.length === 0) {
          setSelectedGamePk('');
          setGameState(createEmptyGameState(modelData, selectedDate));
          setScheduleStatus({ loading: false, error: '' });
          return;
        }

        setSelectedGamePk((current) => {
          const currentExists = nextGames.some((game) => String(game.gamePk) === String(current));
          return currentExists ? current : String(nextGames[0].gamePk);
        });
      } catch (error) {
        if (!ignore) {
          setGames([]);
          setSelectedGamePk('');
          setScheduleStatus({
            loading: false,
            error: error.message || 'Unable to load the MLB schedule right now.',
          });
        }
        return;
      }

      if (!ignore) {
        setScheduleStatus({ loading: false, error: '' });
      }
    }

    loadSchedule();

    return () => {
      ignore = true;
    };
  }, [selectedDate]);

  useEffect(() => {
    let ignore = false;

    async function loadFinalResults() {
      if (!isValidDateString(selectedDate)) {
        if (!ignore) {
          setFinalResults([]);
          setRecentResults([]);
          setResultsStatus({
            loading: false,
            error: 'Choose a valid date to load final results.',
          });
        }
        return;
      }

      setResultsStatus({ loading: true, error: '' });
      const recentDates = [0, 1, 2]
        .map((daysBack) => previousDateString(selectedDate, daysBack))
        .filter(Boolean);

      try {
        const [selectedDateResponse, ...recentDateResponses] = await Promise.all([
          fetchFinalResultsByDate(selectedDate),
          ...recentDates.slice(1).map((date) => fetchFinalResultsByDate(date)),
        ]);
        if (!ignore) {
          setFinalResults(selectedDateResponse.games || []);
          setRecentResults(
            [
              {
                date: selectedDate,
                label: formatResultDate(selectedDate),
                games: selectedDateResponse.games || [],
              },
              ...recentDates.slice(1).map((date, index) => ({
                date,
                label: formatResultDate(date),
                games: recentDateResponses[index]?.games || [],
              })),
            ].filter((section) => section.games.length > 0)
          );
          setResultsStatus({
            loading: false,
            error: selectedDateResponse.error || '',
          });
        }
      } catch (error) {
        if (!ignore) {
          setFinalResults([]);
          setRecentResults([]);
          setResultsStatus({
            loading: false,
            error: error.message || 'Unable to load completed results for this date.',
          });
        }
      }
    }

    loadFinalResults();

    return () => {
      ignore = true;
    };
  }, [selectedDate]);

  useEffect(() => {
    let ignore = false;

    async function loadFallbacks() {
      try {
        const [fallbackResponse, workbookResponse] = await Promise.all([
          fetchFallbackLineups(),
          fetchWorkbookModelData(),
        ]);
        if (!ignore) {
          const nextFallbackLineups = Object.keys(fallbackResponse.lineups || {}).length
            ? fallbackResponse.lineups
            : workbookResponse.lineups || {};
          setFallbackLineups(nextFallbackLineups);
          setWorkbookModelData({
            lineups: workbookResponse.lineups || {},
            lineupValues: workbookResponse.lineupValues || {},
            params: workbookResponse.params || {},
            pitchers: workbookResponse.pitchers || {},
            teamObp: workbookResponse.teamObp || {},
            teamKVsR: workbookResponse.teamKVsR || {},
            teamKVsL: workbookResponse.teamKVsL || {},
            venueFactors: workbookResponse.venueFactors || {},
            bullpenFipByTeam: workbookResponse.bullpenFipByTeam || {},
          });
        }
      } catch (error) {
        if (!ignore) {
          setFallbackLineups({});
          setWorkbookModelData({
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
      }
    }

    loadFallbacks();

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let ignore = false;

    async function loadPowerRankings() {
      setRankingsStatus({ loading: true, error: '' });

      try {
        const response = await fetchPowerRankings();
        if (ignore) {
          return;
        }

        setRankingsSource(response.source || '');
        setRankingsStatus({
          loading: false,
          error: response.error || '',
        });
      } catch (error) {
        if (!ignore) {
          setRankingsStatus({
            loading: false,
            error: error.message || 'Unable to load MLB.com power rankings.',
          });
        }
      }
    }

    loadPowerRankings();

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedGame) {
      return;
    }

    setGameState((current) => ({
      ...buildGameStateFromSelection(selectedGame, modelData, current),
      workbookModelData,
    }));
  }, [selectedGame, workbookModelData]);

  useEffect(() => {
    let ignore = false;

    async function loadSportsInsightsWeather() {
      if (!selectedGame?.awayTeam?.name || !selectedGame?.homeTeam?.name) {
        if (!ignore) {
          setWeatherStatus({ loading: false, error: '', source: '' });
        }
        return;
      }

      setWeatherStatus({ loading: true, error: '', source: '' });

      try {
        const response = await fetchSportsInsightsWeather({
          awayTeam: selectedGame.awayTeam.name,
          homeTeam: selectedGame.homeTeam.name,
          date: selectedDate,
        });

        if (ignore) {
          return;
        }

        const weather = response.weather;
        if (!weather) {
          setWeatherStatus({
            loading: false,
            error: response.error || 'Sports Insights weather was not available for this matchup.',
            source: '',
          });
          return;
        }

        setGameState((current) => ({
          ...current,
          venue: weather.venue || current.venue,
          environment: {
            ...current.environment,
            temperature: Number.isFinite(Number(weather.temperature))
              ? weather.temperature
              : current.environment.temperature,
            windMph: Number.isFinite(Number(weather.windMph))
              ? weather.windMph
              : current.environment.windMph,
            windDirection: weather.windDirection || current.environment.windDirection,
            condition: weather.condition || current.environment.condition,
          },
        }));
        setWeatherStatus({
          loading: false,
          error: '',
          source: weather.source || 'Sports Insights',
        });
      } catch (error) {
        if (!ignore) {
          setWeatherStatus({
            loading: false,
            error: error.message || 'Unable to load Sports Insights weather.',
            source: '',
          });
        }
      }
    }

    loadSportsInsightsWeather();

    return () => {
      ignore = true;
    };
  }, [selectedDate, selectedGame]);

  useEffect(() => {
    let ignore = false;
    const teamAbbreviations = [gameState.awayTeam.abbreviation, gameState.homeTeam.abbreviation].filter(Boolean);

    async function loadLineupInjuries() {
      if (!teamAbbreviations.length) {
        if (!ignore) {
          setInjuryStatus({ loading: false, error: '' });
          setInjuriesByTeam({});
        }
        return;
      }

      setInjuryStatus({ loading: true, error: '' });

      try {
        const response = await fetchLineupInjuries(teamAbbreviations);
        if (ignore) {
          return;
        }

        setInjuriesByTeam(response.injuriesByTeam || {});
        setInjuryStatus({
          loading: false,
          error: response.error || '',
        });
      } catch (error) {
        if (!ignore) {
          setInjuriesByTeam({});
          setInjuryStatus({
            loading: false,
            error: error.message || 'Unable to load Ball Don’t Lie injury data.',
          });
        }
      }
    }

    loadLineupInjuries();

    return () => {
      ignore = true;
    };
  }, [gameState.awayTeam.abbreviation, gameState.homeTeam.abbreviation]);

  useEffect(() => {
    setGameState((current) => {
      const nextAwayRating = teamStrengthRatings[current.awayTeam.abbreviation] ?? current.awayTeam.offenseRating;
      const nextHomeRating = teamStrengthRatings[current.homeTeam.abbreviation] ?? current.homeTeam.offenseRating;

      if (
        Number(current.awayTeam.offenseRating) === Number(nextAwayRating) &&
        Number(current.homeTeam.offenseRating) === Number(nextHomeRating)
      ) {
        return current;
      }

      return {
        ...current,
        awayTeam: {
          ...current.awayTeam,
          offenseRating: nextAwayRating,
        },
        homeTeam: {
          ...current.homeTeam,
          offenseRating: nextHomeRating,
        },
      };
    });
  }, [teamStrengthRatings]);

  useEffect(() => {
    window.localStorage.setItem('mlbModelCurrentTeamStrengths', JSON.stringify(teamStrengthRatings));
    window.localStorage.setItem('mlbModelTeamStrengthsVersion', TEAM_STRENGTH_STORAGE_VERSION);
  }, [teamStrengthRatings]);

  useEffect(() => {
    window.localStorage.setItem('mlbModelSeedTeamStrengths', JSON.stringify(seedTeamStrengthRatings));
    window.localStorage.setItem('mlbModelTeamStrengthsVersion', TEAM_STRENGTH_STORAGE_VERSION);
  }, [seedTeamStrengthRatings]);

  useEffect(() => {
    window.localStorage.setItem(BUILD_STYLE_STORAGE_KEY, buildStyle);
  }, [buildStyle]);

  useEffect(() => {
    setGameState((current) => {
      const nextAwaySourceLineup = buildStyle === 'contrarian'
        ? awayPostedLineup.length
          ? normalizeLineupFromPosted(
              awayPostedLineup,
              createLineupFromNames(current.awayTeam.name, modelData.defaultHitterRatingsBySpot)
            )
          : awaySheetLineupNames.length
            ? createLineupFromNames(current.awayTeam.name, modelData.defaultHitterRatingsBySpot, awaySheetLineupNames)
            : awaySheetLineupEntries.length
              ? createLineupFromNames(
                  current.awayTeam.name,
                  modelData.defaultHitterRatingsBySpot,
                  awaySheetLineupEntries.map((entry) => entry?.name).filter(Boolean)
                )
              : current.awayTeam.lineup
        : awaySheetLineupEntries.length
          ? createLineupFromWorkbookEntries(
              current.awayTeam.name,
              modelData.defaultHitterRatingsBySpot,
              awaySheetLineupEntries
            )
          : awaySheetLineupNames.length
            ? createLineupFromNames(current.awayTeam.name, modelData.defaultHitterRatingsBySpot, awaySheetLineupNames)
            : awayPostedLineup.length
              ? normalizeLineupFromPosted(
                  awayPostedLineup,
                  createLineupFromNames(current.awayTeam.name, modelData.defaultHitterRatingsBySpot)
                )
              : current.awayTeam.lineup;
      const nextHomeSourceLineup = buildStyle === 'contrarian'
        ? homePostedLineup.length
          ? normalizeLineupFromPosted(
              homePostedLineup,
              createLineupFromNames(current.homeTeam.name, modelData.defaultHitterRatingsBySpot)
            )
          : homeSheetLineupNames.length
            ? createLineupFromNames(current.homeTeam.name, modelData.defaultHitterRatingsBySpot, homeSheetLineupNames)
            : homeSheetLineupEntries.length
              ? createLineupFromNames(
                  current.homeTeam.name,
                  modelData.defaultHitterRatingsBySpot,
                  homeSheetLineupEntries.map((entry) => entry?.name).filter(Boolean)
                )
              : current.homeTeam.lineup
        : homeSheetLineupEntries.length
          ? createLineupFromWorkbookEntries(
              current.homeTeam.name,
              modelData.defaultHitterRatingsBySpot,
              homeSheetLineupEntries
            )
          : homeSheetLineupNames.length
            ? createLineupFromNames(current.homeTeam.name, modelData.defaultHitterRatingsBySpot, homeSheetLineupNames)
            : homePostedLineup.length
              ? normalizeLineupFromPosted(
                  homePostedLineup,
                  createLineupFromNames(current.homeTeam.name, modelData.defaultHitterRatingsBySpot)
                )
              : current.homeTeam.lineup;
      const nextAwayLineup = mergeLineupWithSource(current.awayTeam.lineup, nextAwaySourceLineup);
      const nextHomeLineup = mergeLineupWithSource(current.homeTeam.lineup, nextHomeSourceLineup);
      const awayChanged = lineupSignature(nextAwayLineup) !== lineupSignature(current.awayTeam.lineup);
      const homeChanged = lineupSignature(nextHomeLineup) !== lineupSignature(current.homeTeam.lineup);

      if (!awayChanged && !homeChanged) {
        return current;
      }

      return {
        ...current,
        workbookModelData,
        awayTeam: {
          ...current.awayTeam,
          lineup: nextAwayLineup,
        },
        homeTeam: {
          ...current.homeTeam,
          lineup: nextHomeLineup,
        },
      };
    });
  }, [
    awaySheetLineupEntries,
    awaySheetLineupNames,
    awayPostedLineup,
    homeSheetLineupEntries,
    homeSheetLineupNames,
    homePostedLineup,
    buildStyle,
    workbookModelData,
  ]);

  useEffect(() => {
    setGameState((current) => {
      const awayWorkbookPitcher =
        workbookModelData.pitchers[normalizeNameKey(current.awayTeam.probablePitcher.name)];
      const homeWorkbookPitcher =
        workbookModelData.pitchers[normalizeNameKey(current.homeTeam.probablePitcher.name)];
      const nextAwayTeam = awayWorkbookPitcher
        ? {
            ...current.awayTeam,
            probablePitcher: {
              ...current.awayTeam.probablePitcher,
              hand: awayWorkbookPitcher.hand || current.awayTeam.probablePitcher.hand,
              mlbamId: awayWorkbookPitcher.mlbamId ?? current.awayTeam.probablePitcher.mlbamId,
              fip: awayWorkbookPitcher.fip ?? current.awayTeam.probablePitcher.fip,
              l30KRate: awayWorkbookPitcher.l30KRate ?? current.awayTeam.probablePitcher.l30KRate,
              seasonKRate: awayWorkbookPitcher.seasonKRate ?? current.awayTeam.probablePitcher.seasonKRate,
              lastYearKRate: awayWorkbookPitcher.lastYearKRate ?? current.awayTeam.probablePitcher.lastYearKRate,
              csw: awayWorkbookPitcher.csw ?? current.awayTeam.probablePitcher.csw,
              whip: awayWorkbookPitcher.whip ?? current.awayTeam.probablePitcher.whip,
              currentIp: awayWorkbookPitcher.currentIp ?? current.awayTeam.probablePitcher.currentIp,
              ip2026: awayWorkbookPitcher.ip2026 ?? current.awayTeam.probablePitcher.ip2026,
              ip2025: awayWorkbookPitcher.ip2025 ?? current.awayTeam.probablePitcher.ip2025,
            },
          }
        : current.awayTeam;
      const nextHomeTeam = homeWorkbookPitcher
        ? {
            ...current.homeTeam,
            probablePitcher: {
              ...current.homeTeam.probablePitcher,
              hand: homeWorkbookPitcher.hand || current.homeTeam.probablePitcher.hand,
              mlbamId: homeWorkbookPitcher.mlbamId ?? current.homeTeam.probablePitcher.mlbamId,
              fip: homeWorkbookPitcher.fip ?? current.homeTeam.probablePitcher.fip,
              l30KRate: homeWorkbookPitcher.l30KRate ?? current.homeTeam.probablePitcher.l30KRate,
              seasonKRate: homeWorkbookPitcher.seasonKRate ?? current.homeTeam.probablePitcher.seasonKRate,
              lastYearKRate: homeWorkbookPitcher.lastYearKRate ?? current.homeTeam.probablePitcher.lastYearKRate,
              csw: homeWorkbookPitcher.csw ?? current.homeTeam.probablePitcher.csw,
              whip: homeWorkbookPitcher.whip ?? current.homeTeam.probablePitcher.whip,
              currentIp: homeWorkbookPitcher.currentIp ?? current.homeTeam.probablePitcher.currentIp,
              ip2026: homeWorkbookPitcher.ip2026 ?? current.homeTeam.probablePitcher.ip2026,
              ip2025: homeWorkbookPitcher.ip2025 ?? current.homeTeam.probablePitcher.ip2025,
            },
          }
        : current.homeTeam;
      const nextParkFactor =
        workbookModelData.venueFactors[current.homeTeam.abbreviation] || current.environment.parkFactor;
      const nextAwayBullpenFip =
        workbookModelData.bullpenFipByTeam?.[current.awayTeam.abbreviation] ?? current.awayTeam.bullpenFip;
      const nextHomeBullpenFip =
        workbookModelData.bullpenFipByTeam?.[current.homeTeam.abbreviation] ?? current.homeTeam.bullpenFip;

      return {
        ...current,
        awayTeam: {
          ...nextAwayTeam,
          bullpenFip: nextAwayBullpenFip,
        },
        homeTeam: {
          ...nextHomeTeam,
          bullpenFip: nextHomeBullpenFip,
        },
        environment: {
          ...current.environment,
          parkFactor: nextParkFactor,
        },
        workbookModelData,
      };
    });
  }, [
    workbookModelData,
    gameState.awayTeam.abbreviation,
    gameState.homeTeam.abbreviation,
    gameState.awayTeam.probablePitcher.name,
    gameState.homeTeam.probablePitcher.name,
  ]);

  useEffect(() => {
    let ignore = false;

    async function loadRotowire() {
      setRotowireStatus({ loading: true, error: '' });

      try {
        const response = await fetchRotowireLineups(selectedDate);
        if (!ignore) {
          setPostedLineups(response.games || []);
          setRotowireStatus({
            loading: false,
            error: response.error || '',
          });
        }
      } catch (error) {
        if (!ignore) {
          setPostedLineups([]);
          setRotowireStatus({
            loading: false,
            error: error.message || 'RotoWire lineups are not available right now.',
          });
        }
      }
    }

    loadRotowire();

    return () => {
      ignore = true;
    };
  }, [selectedDate]);

  useEffect(() => {
    let ignore = false;

    async function loadLastOutings() {
      const requests = [
        {
          side: 'awayTeam',
          pitcherId: awayPitcherMlbamId,
        },
        {
          side: 'homeTeam',
          pitcherId: homePitcherMlbamId,
        },
      ].filter(({ pitcherId }) => pitcherId);

      if (!requests.length) {
        setGameState((current) => {
          const awayNeedsReset =
            !current.awayTeam.probablePitcher.mlbamId &&
            (current.awayTeam.probablePitcher.ksLastOuting != null ||
              current.awayTeam.probablePitcher.lastOutingDate ||
              current.awayTeam.probablePitcher.lastOutingOpponent);
          const homeNeedsReset =
            !current.homeTeam.probablePitcher.mlbamId &&
            (current.homeTeam.probablePitcher.ksLastOuting != null ||
              current.homeTeam.probablePitcher.lastOutingDate ||
              current.homeTeam.probablePitcher.lastOutingOpponent);

          if (!awayNeedsReset && !homeNeedsReset) {
            return current;
          }

          return {
            ...current,
            awayTeam: awayNeedsReset
              ? {
                  ...current.awayTeam,
                  probablePitcher: {
                    ...current.awayTeam.probablePitcher,
                    ksLastOuting: null,
                    lastOutingDate: '',
                    lastOutingOpponent: '',
                  },
                }
              : current.awayTeam,
            homeTeam: homeNeedsReset
              ? {
                  ...current.homeTeam,
                  probablePitcher: {
                    ...current.homeTeam.probablePitcher,
                    ksLastOuting: null,
                    lastOutingDate: '',
                    lastOutingOpponent: '',
                  },
                }
              : current.homeTeam,
          };
        });
        return;
      }

      try {
        const responses = await Promise.all(
          requests.map(async ({ side, pitcherId }) => {
            const response = await fetchPitcherLastOuting(
              pitcherId,
              selectedDate
            );
            return {
              side,
              outing: response.outing || null,
            };
          })
        );

        if (ignore) {
          return;
        }

        setGameState((current) => {
          let changed = false;
          const nextState = { ...current };
          const responseBySide = Object.fromEntries(
            responses.map(({ side, outing }) => [side, outing])
          );

          ['awayTeam', 'homeTeam'].forEach((side) => {
            const currentPitcher = current[side].probablePitcher;
            const outing = responseBySide[side] || null;
            const nextKs = currentPitcher.mlbamId ? outing?.strikeouts ?? null : null;
            const nextDate = currentPitcher.mlbamId ? outing?.date || '' : '';
            const nextOpponent = currentPitcher.mlbamId ? outing?.opponent || '' : '';

            if (
              currentPitcher.ksLastOuting === nextKs &&
              currentPitcher.lastOutingDate === nextDate &&
              currentPitcher.lastOutingOpponent === nextOpponent
            ) {
              return;
            }

            changed = true;
            nextState[side] = {
              ...current[side],
              probablePitcher: {
                ...currentPitcher,
                ksLastOuting: nextKs,
                lastOutingDate: nextDate,
                lastOutingOpponent: nextOpponent,
              },
            };
          });

          return changed ? nextState : current;
        });
      } catch (error) {
        if (!ignore) {
          setGameState((current) => ({
            ...current,
            awayTeam: {
              ...current.awayTeam,
              probablePitcher: {
                ...current.awayTeam.probablePitcher,
                ksLastOuting: current.awayTeam.probablePitcher.mlbamId
                  ? current.awayTeam.probablePitcher.ksLastOuting
                  : null,
              },
            },
            homeTeam: {
              ...current.homeTeam,
              probablePitcher: {
                ...current.homeTeam.probablePitcher,
                ksLastOuting: current.homeTeam.probablePitcher.mlbamId
                  ? current.homeTeam.probablePitcher.ksLastOuting
                  : null,
              },
            },
          }));
        }
      }
    }

    loadLastOutings();

    return () => {
      ignore = true;
    };
  }, [awayPitcherMlbamId, homePitcherMlbamId, selectedDate]);

  function updateGameInfo(field, value) {
    setGameState((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function updateEnvironment(field, value) {
    setGameState((current) => ({
      ...current,
      environment: {
        ...current.environment,
        [field]: value,
      },
    }));
  }

  function updatePitcherField(side, field, value) {
    setGameState((current) => {
      if (field !== 'name') {
        return {
          ...current,
          [side]: {
            ...current[side],
            probablePitcher: {
              ...current[side].probablePitcher,
              [field]: value,
            },
          },
        };
      }

      const workbookPitcher = workbookModelData.pitchers[normalizeNameKey(value)];
      if (!workbookPitcher) {
        return {
          ...current,
          [side]: {
            ...current[side],
            probablePitcher: {
              ...current[side].probablePitcher,
              name: value,
              mlbamId: null,
              ksLastOuting: null,
              lastOutingDate: '',
              lastOutingOpponent: '',
            },
          },
        };
      }

      const currentPitcher = current[side].probablePitcher;
      const inferredK9 =
        workbookPitcher.seasonKRate != null
          ? Number(workbookPitcher.seasonKRate) * 27
          : workbookPitcher.l30KRate != null
            ? Number(workbookPitcher.l30KRate) * 27
            : currentPitcher.k9;
      const inferredBattersFaced =
        workbookPitcher.currentIp != null
          ? Math.round(Number(workbookPitcher.currentIp) * 4.2)
          : workbookPitcher.ip2026 != null
            ? Math.round(Number(workbookPitcher.ip2026) * 4.2)
            : currentPitcher.battersFaced;

      return {
        ...current,
        [side]: {
          ...current[side],
          probablePitcher: {
            ...currentPitcher,
            name: workbookPitcher.name || value,
            hand: workbookPitcher.hand || currentPitcher.hand,
            mlbamId: workbookPitcher.mlbamId ?? currentPitcher.mlbamId,
            fip: workbookPitcher.fip ?? currentPitcher.fip,
            k9: inferredK9,
            battersFaced: inferredBattersFaced,
            l30KRate: workbookPitcher.l30KRate ?? currentPitcher.l30KRate,
            seasonKRate: workbookPitcher.seasonKRate ?? currentPitcher.seasonKRate,
            lastYearKRate: workbookPitcher.lastYearKRate ?? currentPitcher.lastYearKRate,
            csw: workbookPitcher.csw ?? currentPitcher.csw,
            whip: workbookPitcher.whip ?? currentPitcher.whip,
            currentIp: workbookPitcher.currentIp ?? currentPitcher.currentIp,
            ip2026: workbookPitcher.ip2026 ?? currentPitcher.ip2026,
            ip2025: workbookPitcher.ip2025 ?? currentPitcher.ip2025,
            ksLastOuting: currentPitcher.ksLastOuting,
            lastOutingDate: currentPitcher.lastOutingDate,
            lastOutingOpponent: currentPitcher.lastOutingOpponent,
          },
        },
      };
    });
  }

  function updateLineupPlayer(side, index, field, value) {
    setGameState((current) => {
      if (field !== 'name') {
        return {
          ...current,
          [side]: {
            ...current[side],
            lineup: current[side].lineup.map((player, playerIndex) =>
              playerIndex === index
                ? {
                    ...player,
                    [field]: value,
                    manualRating: field === 'rating' ? true : player.manualRating,
                    manualSlot: field === 'slot' ? true : player.manualSlot,
                  }
                : player
            ),
          },
        };
      }

      const opponentSide = side === 'awayTeam' ? 'homeTeam' : 'awayTeam';
      const pitcherHand = current[opponentSide].probablePitcher.hand;
      const workbookEntries = getFallbackLineupForHand(
        workbookModelData.lineupValues || {},
        current[side].abbreviation,
        pitcherHand
      );
      const workbookEntry = workbookEntries.find(
        (entry) => normalizeNameKey(entry?.name) === normalizeNameKey(value)
      );

      return {
        ...current,
        [side]: {
          ...current[side],
          lineup: current[side].lineup.map((player, playerIndex) =>
            playerIndex === index
              ? {
                  ...player,
                  name: value,
                  rating: workbookEntry?.rating ?? player.rating,
                  manualName: true,
                  manualRating: workbookEntry ? false : player.manualRating,
                }
              : player
          ),
        },
      };
    });
  }

  function handleTeamChange(side, abbreviation) {
    setGameState((current) => {
      const nextState = updateTeamFromAbbreviation(current, side, abbreviation, modelData);
      return {
        ...nextState,
        [side]: {
          ...nextState[side],
          offenseRating: teamStrengthRatings[abbreviation] ?? nextState[side].offenseRating,
        },
        workbookModelData,
      };
    });
  }

  function applyPostedLineup(side) {
    if (!rotowireMatchup) {
      return;
    }

    const postedLineup = side === 'awayTeam'
      ? filterPostedLineupByAvailability(rotowireMatchup.awayLineup, awayUnavailablePlayerMatcher)
      : filterPostedLineupByAvailability(rotowireMatchup.homeLineup, homeUnavailablePlayerMatcher);
    if (!postedLineup || postedLineup.length === 0) {
      return;
    }

    setGameState((current) => ({
      ...current,
      [side]: {
        ...current[side],
        lineup: normalizeLineupFromPosted(postedLineup, current[side].lineup),
      },
    }));
  }

  const awayMismatch = hasLineupMismatch(awaySheetLineup, rotowireMatchup?.awayLineup || []);
  const homeMismatch = hasLineupMismatch(homeSheetLineup, rotowireMatchup?.homeLineup || []);

  function buildLineupStatus(sheetNames, postedLineup) {
    if (sheetNames.length) {
      if (postedLineup.length) {
        return 'Spreadsheet lineup loaded. RotoWire is available for comparison or replacement.';
      }

      return 'Spreadsheet lineup loaded from the workbook.';
    }

    if (postedLineup.length) {
      return 'Spreadsheet lineup was not found for this split, so the lineup is using RotoWire.';
    }

    return 'No spreadsheet or RotoWire lineup was found yet.';
  }

  function buildMismatchNote(hasMismatch, postedLineup) {
    if (!postedLineup.length || !hasMismatch) {
      return '';
    }

    return 'RotoWire differs slightly from the spreadsheet lineup.';
  }

  function formatLastOuting(pitcher) {
    if (pitcher.ksLastOuting == null) {
      return 'N/A';
    }

    return String(Number(pitcher.ksLastOuting));
  }

  function formatStarterResultLine(team) {
    const inningsPitched = team.starterInningsPitched || 'N/A';
    const strikeouts = team.starterStrikeouts ?? 'N/A';
    return `${team.starterName || 'Starter'}: ${inningsPitched} IP • ${strikeouts} K`;
  }

  function buildLineupAvailabilityNote(team) {
    const injuries = injuriesByTeam[team.abbreviation] || [];
    if (!injuries.length) {
      return injuryStatus.error ? injuryStatus.error : '';
    }

    const lineupNames = team.lineup.map((player) => player.name);
    const impacted = injuries.filter((injury) =>
      lineupNames.some((name) => isUnavailablePlayerName(name, buildUnavailablePlayerMatcher([injury])))
    );

    if (!impacted.length) {
      return '';
    }

    const names = impacted.slice(0, 2).map((injury) => injury.playerName);
    const suffix = impacted.length > 2 ? ` and ${impacted.length - 2} more` : '';
    return `Ball Don't Lie flags ${names.join(', ')}${suffix} as out.`;
  }

  function updateTeamStrength(abbreviation, value) {
    const nextValue = Number(value);
    setTeamStrengthRatings((current) => ({
      ...current,
      [abbreviation]: Number.isFinite(nextValue) ? nextValue : current[abbreviation],
    }));
  }

  function saveCurrentTeamStrengthsAsSeed() {
    setSeedTeamStrengthRatings(teamStrengthRatings);
  }

  function resetTeamStrengths() {
    setTeamStrengthRatings(seedTeamStrengthRatings);
  }

  function buildProjectionStateForGame(game) {
    const seededState = buildGameStateFromSelection(
      game,
      modelData,
      createEmptyGameState(modelData, selectedDate)
    );

    const awayWorkbookPitcher =
      workbookModelData.pitchers[normalizeNameKey(seededState.awayTeam.probablePitcher.name)];
    const homeWorkbookPitcher =
      workbookModelData.pitchers[normalizeNameKey(seededState.homeTeam.probablePitcher.name)];

    const awayTeam = {
      ...seededState.awayTeam,
      offenseRating: teamStrengthRatings[seededState.awayTeam.abbreviation] ?? seededState.awayTeam.offenseRating,
      bullpenFip:
        workbookModelData.bullpenFipByTeam?.[seededState.awayTeam.abbreviation] ?? seededState.awayTeam.bullpenFip,
      probablePitcher: awayWorkbookPitcher
        ? {
            ...seededState.awayTeam.probablePitcher,
            hand: awayWorkbookPitcher.hand || seededState.awayTeam.probablePitcher.hand,
            mlbamId: awayWorkbookPitcher.mlbamId ?? seededState.awayTeam.probablePitcher.mlbamId,
            fip: awayWorkbookPitcher.fip ?? seededState.awayTeam.probablePitcher.fip,
            l30KRate: awayWorkbookPitcher.l30KRate ?? seededState.awayTeam.probablePitcher.l30KRate,
            seasonKRate: awayWorkbookPitcher.seasonKRate ?? seededState.awayTeam.probablePitcher.seasonKRate,
            lastYearKRate: awayWorkbookPitcher.lastYearKRate ?? seededState.awayTeam.probablePitcher.lastYearKRate,
            csw: awayWorkbookPitcher.csw ?? seededState.awayTeam.probablePitcher.csw,
            whip: awayWorkbookPitcher.whip ?? seededState.awayTeam.probablePitcher.whip,
            currentIp: awayWorkbookPitcher.currentIp ?? seededState.awayTeam.probablePitcher.currentIp,
            ip2026: awayWorkbookPitcher.ip2026 ?? seededState.awayTeam.probablePitcher.ip2026,
            ip2025: awayWorkbookPitcher.ip2025 ?? seededState.awayTeam.probablePitcher.ip2025,
          }
        : seededState.awayTeam.probablePitcher,
    };

    const homeTeam = {
      ...seededState.homeTeam,
      offenseRating: teamStrengthRatings[seededState.homeTeam.abbreviation] ?? seededState.homeTeam.offenseRating,
      bullpenFip:
        workbookModelData.bullpenFipByTeam?.[seededState.homeTeam.abbreviation] ?? seededState.homeTeam.bullpenFip,
      probablePitcher: homeWorkbookPitcher
        ? {
            ...seededState.homeTeam.probablePitcher,
            hand: homeWorkbookPitcher.hand || seededState.homeTeam.probablePitcher.hand,
            mlbamId: homeWorkbookPitcher.mlbamId ?? seededState.homeTeam.probablePitcher.mlbamId,
            fip: homeWorkbookPitcher.fip ?? seededState.homeTeam.probablePitcher.fip,
            l30KRate: homeWorkbookPitcher.l30KRate ?? seededState.homeTeam.probablePitcher.l30KRate,
            seasonKRate: homeWorkbookPitcher.seasonKRate ?? seededState.homeTeam.probablePitcher.seasonKRate,
            lastYearKRate: homeWorkbookPitcher.lastYearKRate ?? seededState.homeTeam.probablePitcher.lastYearKRate,
            csw: homeWorkbookPitcher.csw ?? seededState.homeTeam.probablePitcher.csw,
            whip: homeWorkbookPitcher.whip ?? seededState.homeTeam.probablePitcher.whip,
            currentIp: homeWorkbookPitcher.currentIp ?? seededState.homeTeam.probablePitcher.currentIp,
            ip2026: homeWorkbookPitcher.ip2026 ?? seededState.homeTeam.probablePitcher.ip2026,
            ip2025: homeWorkbookPitcher.ip2025 ?? seededState.homeTeam.probablePitcher.ip2025,
          }
        : seededState.homeTeam.probablePitcher,
    };

    const awayLineupEntries = getFallbackLineupForHand(
      workbookModelData.lineupValues || {},
      awayTeam.abbreviation,
      homeTeam.probablePitcher.hand
    );
    const homeLineupEntries = getFallbackLineupForHand(
      workbookModelData.lineupValues || {},
      homeTeam.abbreviation,
      awayTeam.probablePitcher.hand
    );
    const awayLineupNames = getFallbackLineupForHand(
      combinedLineups,
      awayTeam.abbreviation,
      homeTeam.probablePitcher.hand
    );
    const homeLineupNames = getFallbackLineupForHand(
      combinedLineups,
      homeTeam.abbreviation,
      awayTeam.probablePitcher.hand
    );

    return {
      ...seededState,
      workbookModelData,
      awayTeam: {
        ...awayTeam,
        lineup: awayLineupEntries.length
          ? createLineupFromWorkbookEntries(
              awayTeam.name,
              modelData.defaultHitterRatingsBySpot,
              awayLineupEntries
            )
          : createLineupFromNames(
              awayTeam.name,
              modelData.defaultHitterRatingsBySpot,
              awayLineupNames
            ),
      },
      homeTeam: {
        ...homeTeam,
        lineup: homeLineupEntries.length
          ? createLineupFromWorkbookEntries(
              homeTeam.name,
              modelData.defaultHitterRatingsBySpot,
              homeLineupEntries
            )
          : createLineupFromNames(
              homeTeam.name,
              modelData.defaultHitterRatingsBySpot,
              homeLineupNames
            ),
      },
      environment: {
        ...seededState.environment,
        parkFactor:
          workbookModelData.venueFactors[homeTeam.abbreviation] || seededState.environment.parkFactor,
      },
    };
  }

  function handleDownloadProjectionWorkbook() {
    if (!games.length) {
      return;
    }

    const gamesWithProjections = games.map((game) => {
      const projectionState = buildProjectionStateForGame(game);
      return {
        game,
        projections: calculateProjections(projectionState),
      };
    });

    downloadProjectionWorkbook({
      date: selectedDate,
      gamesWithProjections,
    });
  }

  const rankedTeams = useMemo(
    () =>
      sortTeamsByStrength(modelData.teams, teamStrengthRatings).map((team, index) => ({
        ...team,
        currentStrength: teamStrengthRatings[team.abbreviation] ?? team.offenseRating ?? 100,
        seedStrength: seedTeamStrengthRatings[team.abbreviation] ?? team.offenseRating ?? 100,
        currentRank: index + 1,
      })),
    [seedTeamStrengthRatings, teamStrengthRatings]
  );

  return (
    <div className="app-shell">
      <div className="app-backdrop" />
      <main className="app-layout">
        <section className="top-nav">
          <button
            type="button"
            className={`tab-button ${activeTab === 'model' ? 'active' : ''}`}
            onClick={() => setActiveTab('model')}
          >
            Model
          </button>
          <button
            type="button"
            className={`tab-button ${activeTab === 'results' ? 'active' : ''}`}
            onClick={() => setActiveTab('results')}
          >
            Final Results
          </button>
          <button
            type="button"
            className={`tab-button ${activeTab === 'rankings' ? 'active' : ''}`}
            onClick={() => setActiveTab('rankings')}
          >
            Team Rankings
          </button>
        </section>

        {activeTab === 'model' ? (
          <>
            <section className="panel summary-panel">
              <div className="panel-header">
                <div>
                  <h2>Game Setup</h2>
                  <p className="muted-text">
                    {selectedGame ? formatGameLabel(selectedGame) : `${gameState.awayTeam.abbreviation} at ${gameState.homeTeam.abbreviation}`}
                  </p>
                </div>
                <div className="status-row">
                  <span className={`status-pill ${scheduleStatus.loading ? 'loading' : ''}`}>
                    {scheduleStatus.loading ? 'Loading schedule...' : `${games.length} game${games.length === 1 ? '' : 's'} found`}
                  </span>
                  <span className={`status-pill ${rotowireStatus.loading ? 'loading' : ''}`}>
                    {rotowireStatus.loading ? 'Checking RotoWire...' : rotowireStatus.error ? 'RotoWire unavailable' : 'RotoWire checked'}
                  </span>
                </div>
              </div>
              <div className="selector-grid">
                <label className="field">
                  <span>Date</span>
                  <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
                </label>
                <label className="field field-wide">
                  <span>MLB Game</span>
                  <select value={selectedGamePk} onChange={(event) => setSelectedGamePk(event.target.value)}>
                    {games.length === 0 ? (
                      <option value="">No MLB games on this date</option>
                    ) : (
                      games.map((game) => (
                        <option key={game.gamePk} value={game.gamePk}>
                          {game.awayTeam.abbreviation} at {game.homeTeam.abbreviation} - {game.gameTime} - {game.venue}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <label className="field">
                  <span>Build Style</span>
                  <select value={buildStyle} onChange={(event) => setBuildStyle(event.target.value)}>
                    {BUILD_STYLE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="info-grid">
                <label className="field">
                  <span>Venue</span>
                  <input
                    value={gameState.venue}
                    onChange={(event) => updateGameInfo('venue', event.target.value)}
                    placeholder="Venue"
                  />
                </label>
                <label className="field">
                  <span>First Pitch</span>
                  <input
                    value={gameState.gameTime}
                    onChange={(event) => updateGameInfo('gameTime', event.target.value)}
                    placeholder="7:10 PM ET"
                  />
                </label>
                <label className="field">
                  <span>Status</span>
                  <input
                    value={gameState.gameStatus}
                    onChange={(event) => updateGameInfo('gameStatus', event.target.value)}
                    placeholder="Scheduled"
                  />
                </label>
                <label className="field">
                  <span>Park Factor</span>
                  <input
                    type="number"
                    min="0.7"
                    max="1.4"
                    step="0.01"
                    value={gameState.environment.parkFactor}
                    onChange={(event) => updateEnvironment('parkFactor', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Temperature (F)</span>
                  <input
                    type="number"
                    min="20"
                    max="120"
                    step="1"
                    value={gameState.environment.temperature}
                    onChange={(event) => updateEnvironment('temperature', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Wind (mph)</span>
                  <input
                    type="number"
                    min="0"
                    max="40"
                    step="1"
                    value={gameState.environment.windMph}
                    onChange={(event) => updateEnvironment('windMph', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Wind Direction</span>
                  <select
                    value={gameState.environment.windDirection}
                    onChange={(event) => updateEnvironment('windDirection', event.target.value)}
                  >
                    {modelData.windDirections.map((direction) => (
                      <option key={direction.value} value={direction.value}>
                        {direction.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Weather</span>
                  <select
                    value={gameState.environment.condition}
                    onChange={(event) => updateEnvironment('condition', event.target.value)}
                  >
                    {modelData.weatherPresets.map((preset) => (
                      <option key={preset.value} value={preset.value}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {scheduleStatus.error ? <p className="inline-error">{scheduleStatus.error}</p> : null}
              {weatherStatus.loading ? <p className="inline-note">Loading Sports Insights weather...</p> : null}
              {!weatherStatus.loading && weatherStatus.source ? (
                <p className="inline-note">Weather loaded from Sports Insights. You can still override any field.</p>
              ) : null}
              {!weatherStatus.loading && weatherStatus.error ? <p className="inline-note">{weatherStatus.error}</p> : null}
              {rotowireStatus.error ? <p className="inline-note">{rotowireStatus.error}</p> : null}
            </section>

            <section className="panel summary-panel">
              <div className="panel-header">
                <div>
                  <h2>Projection Summary</h2>
                  <p className="muted-text">
                    {selectedGame ? formatGameLabel(selectedGame) : `${gameState.awayTeam.abbreviation} at ${gameState.homeTeam.abbreviation}`}
                  </p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleDownloadProjectionWorkbook}
                  disabled={scheduleStatus.loading || !games.length}
                >
                  Download Projections XLSX
                </button>
              </div>
              <ProjectionResults
                projections={projections}
                awayTeam={gameState.awayTeam}
                homeTeam={gameState.homeTeam}
                formatRuns={formatRuns}
                formatDecimalOdds={formatDecimalOdds}
                awayLastOuting={formatLastOuting(gameState.awayTeam.probablePitcher)}
                homeLastOuting={formatLastOuting(gameState.homeTeam.probablePitcher)}
              />
            </section>

            <section className="team-grid">
              <TeamEditor
                side="awayTeam"
                team={gameState.awayTeam}
                opponent={gameState.homeTeam}
                title="Away Team"
                teamOptions={teamOptions}
                onTeamChange={handleTeamChange}
                onPitcherFieldChange={updatePitcherField}
                onLineupPlayerChange={updateLineupPlayer}
                pitcherOptions={pitcherOptions}
                batterOptions={awayBatterOptions}
                postedLineup={awayPostedLineup}
                lineupStatusText={buildLineupStatus(awaySheetLineupNames, awayPostedLineup)}
                mismatchNote={buildMismatchNote(awayMismatch, awayPostedLineup)}
                availabilityNote={buildLineupAvailabilityNote(gameState.awayTeam)}
                onApplyPostedLineup={applyPostedLineup}
                workbookStarterFipActive={awayWorkbookStarterFipActive}
                workbookBullpenFipActive={awayWorkbookBullpenFipActive}
              />
              <TeamEditor
                side="homeTeam"
                team={gameState.homeTeam}
                opponent={gameState.awayTeam}
                title="Home Team"
                teamOptions={teamOptions}
                onTeamChange={handleTeamChange}
                onPitcherFieldChange={updatePitcherField}
                onLineupPlayerChange={updateLineupPlayer}
                pitcherOptions={pitcherOptions}
                batterOptions={homeBatterOptions}
                postedLineup={homePostedLineup}
                lineupStatusText={buildLineupStatus(homeSheetLineupNames, homePostedLineup)}
                mismatchNote={buildMismatchNote(homeMismatch, homePostedLineup)}
                availabilityNote={buildLineupAvailabilityNote(gameState.homeTeam)}
                onApplyPostedLineup={applyPostedLineup}
                workbookStarterFipActive={homeWorkbookStarterFipActive}
                workbookBullpenFipActive={homeWorkbookBullpenFipActive}
              />
            </section>

            <section className="panel notes-panel">
              <div className="panel-header">
                <h2>Data Notes</h2>
              </div>
              <div className="notes-grid">
                <div className="note-card">
                  <span className="note-label">Model Inputs</span>
                  <p>
                    Workbook hitter values, workbook bullpen FIPs, MLB probable starters, park factor, and weather
                    all flow directly into the projections below. Missing MLB schedule data falls back to the seeded
                    values in `src/modelData.json`.
                  </p>
                </div>
                <div className="note-card">
                  <span className="note-label">RotoWire Sync</span>
                  <p>
                    {rotowireStatus.error
                      ? rotowireStatus.error
                      : rotowireMatchup
                        ? 'Posted lineup data was found for this matchup. Use Replace Lineup to sync either side instantly.'
                        : 'No posted RotoWire lineup matched this game yet, so the app is using the spreadsheet-based hitter names for this matchup.'}
                  </p>
                </div>
                <div className="note-card">
                  <span className="note-label">Manual Control</span>
                  <p>
                    If you want to handicap a different matchup than the selected schedule game, change either team
                    from the dropdown and keep adjusting the linked pitcher and lineup inputs beneath it.
                  </p>
                </div>
                <div className="note-card">
                  <span className="note-label">Build Style</span>
                  <p>
                    High Projection favors workbook player ratings when available. Contrarian prioritizes posted or
                    name-only lineups so users can pivot away from rating-driven defaults.
                  </p>
                </div>
              </div>
            </section>
          </>
        ) : activeTab === 'results' ? (
        <section className="panel actual-results-panel">
          <div className="panel-header">
            <div>
              <h2>Final Results</h2>
              <p className="muted-text">Completed games for {selectedDate}, shown in Eastern-date context.</p>
            </div>
            <span className="muted-text">
              {resultsStatus.loading ? 'Loading results...' : `${finalResults.length} final game${finalResults.length === 1 ? '' : 's'}`}
            </span>
          </div>
          <div className="results-toolbar">
            <label className="field">
              <span>Date</span>
              <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
            </label>
          </div>
          {resultsStatus.error ? <p className="muted-text">{resultsStatus.error}</p> : null}
          {!resultsStatus.error && !resultsStatus.loading && finalResults.length === 0 ? (
            <p className="muted-text">No completed MLB games were found for this date yet.</p>
          ) : null}
          <div className="actual-results-grid">
            {finalResults.map((game) => (
              <article className="actual-result-card" key={game.gamePk}>
                <div className="actual-result-score">
                  <div className="actual-result-team">
                    <TeamBadge
                      abbreviation={game.awayTeam.abbreviation}
                      name={game.awayTeam.name}
                      compact
                    />
                    <strong>{game.awayTeam.score}</strong>
                  </div>
                  <span className="actual-result-divider">@</span>
                  <div className="actual-result-team">
                    <TeamBadge
                      abbreviation={game.homeTeam.abbreviation}
                      name={game.homeTeam.name}
                      compact
                    />
                    <strong>{game.homeTeam.score}</strong>
                  </div>
                </div>
                <div className="actual-result-meta">
                  <span>{game.status}</span>
                  <span>{game.venue || 'MLB venue'}</span>
                </div>
                <div className="actual-result-k-grid">
                  <div>
                    <span className="note-label">Away Starter</span>
                    <p>{formatStarterResultLine(game.awayTeam)}</p>
                  </div>
                  <div>
                    <span className="note-label">Home Starter</span>
                    <p>{formatStarterResultLine(game.homeTeam)}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
          {!resultsStatus.error && recentResults.length > 0 ? (
            <div className="recent-results-stack">
              <div className="panel-header recent-results-header">
                <div>
                  <h3>Recent Results</h3>
                  <p className="muted-text">Selected date plus the prior two days.</p>
                </div>
              </div>
              {recentResults.map((section) => (
                <div className="recent-results-section" key={section.date}>
                  <div className="recent-results-date-row">
                    <span className="note-label">{section.label}</span>
                    <span className="muted-text">
                      {section.games.length} final game{section.games.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="recent-results-mini-grid">
                    {section.games.map((game) => (
                      <article className="recent-result-mini-card" key={`${section.date}-${game.gamePk}`}>
                        <div className="recent-result-mini-top">
                          <TeamBadge
                            abbreviation={game.awayTeam.abbreviation}
                            name={game.awayTeam.name}
                            compact
                          />
                          <strong>{game.awayTeam.score}</strong>
                          <span className="actual-result-divider">@</span>
                          <strong>{game.homeTeam.score}</strong>
                          <TeamBadge
                            abbreviation={game.homeTeam.abbreviation}
                            name={game.homeTeam.name}
                            compact
                          />
                        </div>
                        <p className="muted-text">
                          {game.awayTeam.starterInningsPitched || 'N/A'} IP, {game.awayTeam.starterStrikeouts ?? 'N/A'} K
                          {' / '}
                          {game.homeTeam.starterInningsPitched || 'N/A'} IP, {game.homeTeam.starterStrikeouts ?? 'N/A'} K
                        </p>
                      </article>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </section>
        ) : (
          <section className="panel rankings-panel">
            <div className="panel-header">
              <div>
                <h2>Team Rankings</h2>
                <p className="muted-text">
                  Update in-season team strength here. Teams re-rank automatically from highest rating to lowest rating.
                </p>
              </div>
              <div className="button-row">
                <button type="button" className="secondary-button" onClick={saveCurrentTeamStrengthsAsSeed}>
                  Use Current As Seed
                </button>
                <button type="button" className="secondary-button" onClick={resetTeamStrengths}>
                  Reset To Seed
                </button>
              </div>
            </div>
            <div className="notes-grid rankings-note-grid">
              <div className="note-card">
                <span className="note-label">How It Works</span>
                <p>
                  The current rating is the live number used by the model. Rank is derived automatically from that rating.
                </p>
              </div>
              <div className="note-card">
                <span className="note-label">Live Model Link</span>
                <p>
                  If the team in your current matchup is edited here, the projection summary updates automatically with the
                  new team-strength number.
                </p>
              </div>
              <div className="note-card">
                <span className="note-label">Editing Tip</span>
                <p>
                  Change a team rating and the order updates immediately. Use `Use Current As Seed` to make those values your new baseline.
                </p>
              </div>
            </div>
            {rankingsStatus.error ? <p className="inline-note">{rankingsStatus.error}</p> : null}
            {!rankingsStatus.error && rankingsSource ? (
              <p className="muted-text">
                Reference source available: MLB.com power rankings proxy
              </p>
            ) : null}
            <div className="rankings-table-wrap">
              <table className="rankings-table">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Team</th>
                    <th>Strength</th>
                    <th>Seeded</th>
                  </tr>
                </thead>
                <tbody>
                  {rankedTeams.map((team) => (
                    <tr key={team.abbreviation}>
                      <td className="rank-cell">{team.currentRank}</td>
                      <td>
                        <TeamBadge abbreviation={team.abbreviation} name={team.name} />
                      </td>
                      <td className="strength-cell">
                        <input
                          type="number"
                          min="80"
                          max="125"
                          step="1"
                          value={team.currentStrength}
                          onChange={(event) => updateTeamStrength(team.abbreviation, event.target.value)}
                        />
                      </td>
                      <td>{team.seedStrength}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
