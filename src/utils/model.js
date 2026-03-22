function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function safeNumber(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getWorkbookParam(params, key, fallback) {
  return safeNumber(params?.[key], fallback);
}

function weatherFactor(environment, params) {
  const temperature = safeNumber(environment.temperature, 72);
  const windMph = safeNumber(environment.windMph, 8);
  const windDirection = String(environment.windDirection || 'neutral').toLowerCase();
  const condition = String(environment.condition || 'clear').toLowerCase();
  const directionalWindAdjustment =
    windDirection === 'out'
      ? windMph * 0.004
      : windDirection === 'in'
        ? windMph * -0.0045
        : windDirection === 'cross'
          ? windMph * -0.0005
          : 0;
  const conditionAdjustment =
    condition === 'dome'
      ? -((temperature - 72) * getWorkbookParam(params, 'Temp_Coef', 0.0025) + (windMph - 8) * getWorkbookParam(params, 'Wind_Coef', 0.003))
      : condition === 'rain'
        ? -0.035
        : condition === 'humid'
          ? 0.012
          : condition === 'cloudy'
            ? -0.005
            : 0;
  const raw =
    1 +
    (temperature - 72) * getWorkbookParam(params, 'Temp_Coef', 0.0025) +
    (windMph - 8) * getWorkbookParam(params, 'Wind_Coef', 0.003) +
    directionalWindAdjustment +
    conditionAdjustment;

  return clamp(
    raw,
    condition === 'dome' ? 0.97 : getWorkbookParam(params, 'Weather_Min', 0.92),
    condition === 'dome' ? 1.03 : getWorkbookParam(params, 'Weather_Max', 1.1)
  );
}

function weightedFip(starterFip, bullpenFip, starterShare, params) {
  const leagueFip = getWorkbookParam(params, 'League_FIP', 4.2);
  const fipPower = getWorkbookParam(params, 'FIP_Power', 1);
  const wfip = starterShare * safeNumber(starterFip, leagueFip) + (1 - starterShare) * safeNumber(bullpenFip, leagueFip);
  return clamp(wfip / leagueFip, 0.75, 1.4) ** fipPower;
}

function pitcherRunSkillFactor(pitcher) {
  const whipFactor = clamp(1 + (safeNumber(pitcher?.whip, 1.25) - 1.25) * 0.18, 0.9, 1.1);
  const strikeoutRate =
    safeNumber(pitcher?.seasonKRate, null) ??
    safeNumber(pitcher?.l30KRate, null) ??
    safeNumber(pitcher?.k9, 8.5) / 27;
  const strikeoutFactor = clamp(1 - (safeNumber(strikeoutRate, 0.24) - 0.24) * 1.2, 0.9, 1.1);
  return clamp(whipFactor * strikeoutFactor, 0.85, 1.15);
}

function starterDominanceFactor(pitcher, starterFip, params) {
  const leagueFip = getWorkbookParam(params, 'League_FIP', 4.2);
  const fipRatio = safeNumber(starterFip, leagueFip) / leagueFip;
  const fipFactor = clamp(fipRatio, 0.7, 1.45) ** 1.35;
  return clamp(fipFactor * pitcherRunSkillFactor(pitcher), 0.62, 1.5);
}

function lineupOffenseRating(lineup) {
  return average(lineup.map((player) => safeNumber(player.rating, 100)));
}

function normalizedTeamStrengthRating(teamStrengthRating, params) {
  const leagueMean = getWorkbookParam(params, 'TeamStrength_Mean', 81.1);
  const spread = getWorkbookParam(params, 'TeamStrength_Spread', 0.8);
  return 100 + (safeNumber(teamStrengthRating, leagueMean) - leagueMean) * spread;
}

function effectiveOffenseRating(lineupRating, teamStrengthRating, params) {
  const lineupWeight = clamp(getWorkbookParam(params, 'Lineup_Weight', 0.7), 0, 1);
  const teamWeight = 1 - lineupWeight;
  const normalizedTeamStrength = normalizedTeamStrengthRating(teamStrengthRating, params);
  return lineupWeight * safeNumber(lineupRating, 100) + teamWeight * normalizedTeamStrength;
}

function expectedRuns({
  lineupRating,
  teamStrengthRating,
  opposingStarter,
  opposingStarterFip,
  opposingBullpenFip,
  environment,
  params,
  starterShare,
  baseRuns,
  homeFieldRuns,
  emphasizeStarter = false,
}) {
  const parkFactor = clamp(
    safeNumber(environment.parkFactor, 1),
    getWorkbookParam(params, 'Park_Min', 0.88),
    getWorkbookParam(params, 'Park_Max', 1.15)
  );
  const offenseRating = effectiveOffenseRating(lineupRating, teamStrengthRating, params);
  const offenseFactor = clamp(
    offenseRating / 100,
    0.75,
    1.3
  );
  const pitchingFactor = emphasizeStarter
    ? starterDominanceFactor(opposingStarter, opposingStarterFip, params)
    : weightedFip(opposingStarterFip, opposingBullpenFip, starterShare, params);
  const raw =
    baseRuns *
      pitchingFactor *
      offenseFactor *
      parkFactor *
      weatherFactor(environment, params) +
    homeFieldRuns;

  return clamp(
    raw,
    getWorkbookParam(params, 'TeamRuns_Min', 1) * (baseRuns / getWorkbookParam(params, 'League_Runs_per_Team', 4.35)),
    getWorkbookParam(params, 'TeamRuns_Max', 10) * (baseRuns / getWorkbookParam(params, 'League_Runs_per_Team', 4.35))
  );
}

function finalizeTotal(raw, market, intercept, slope, marketCoefficient) {
  return intercept + slope * raw + marketCoefficient * safeNumber(market, raw);
}

function calibratedTeamRuns(runsFor, runsAgainst, targetTotal) {
  const safeRunsFor = Math.max(safeNumber(runsFor, 0), 0.01);
  const safeRunsAgainst = Math.max(safeNumber(runsAgainst, 0), 0.01);
  const rawTotal = safeRunsFor + safeRunsAgainst;
  const desiredTotal = Math.max(safeNumber(targetTotal, rawTotal), 0.1);
  const scale = desiredTotal / rawTotal;

  return {
    runsFor: safeRunsFor * scale,
    runsAgainst: safeRunsAgainst * scale,
  };
}

function pythagenpatExponent(runsFor, runsAgainst) {
  return clamp((Math.max(runsFor + runsAgainst, 0.1)) ** 0.287, 1.55, 2.05);
}

function winProbability(runsFor, runsAgainst) {
  const exponent = pythagenpatExponent(runsFor, runsAgainst);
  const numerator = runsFor ** exponent;
  const denominator = numerator + runsAgainst ** exponent;
  return denominator ? numerator / denominator : 0.5;
}

function decimalFromProbability(probability) {
  return 1 / clamp(probability, 0.01, 0.99);
}

function hashSeed(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function samplePoisson(lambda, random) {
  const safeLambda = clamp(safeNumber(lambda, 0), 0.01, 25);
  const limit = Math.exp(-safeLambda);
  let count = 0;
  let product = 1;

  do {
    count += 1;
    product *= random();
  } while (product > limit);

  return count - 1;
}

function simulateMarket({
  homeRuns,
  awayRuns,
  targetTotal,
  simulations,
  pushOnTie,
  seedKey,
}) {
  const calibrated = calibratedTeamRuns(homeRuns, awayRuns, targetTotal);
  const baseHomeProbability = winProbability(calibrated.runsFor, calibrated.runsAgainst);
  const random = createSeededRandom(hashSeed(seedKey));
  let homeWins = 0;
  let awayWins = 0;
  let ties = 0;

  for (let index = 0; index < simulations; index += 1) {
    const simulatedHomeRuns = samplePoisson(calibrated.runsFor, random);
    const simulatedAwayRuns = samplePoisson(calibrated.runsAgainst, random);

    if (simulatedHomeRuns > simulatedAwayRuns) {
      homeWins += 1;
    } else if (simulatedAwayRuns > simulatedHomeRuns) {
      awayWins += 1;
    } else {
      ties += 1;
    }
  }

  if (pushOnTie) {
    const resolvedGames = homeWins + awayWins;
    return {
      homeProbability: resolvedGames ? homeWins / resolvedGames : baseHomeProbability,
      awayProbability: resolvedGames ? awayWins / resolvedGames : 1 - baseHomeProbability,
      pushProbability: ties / simulations,
    };
  }

  return {
    homeProbability: (homeWins + ties * baseHomeProbability) / simulations,
    awayProbability: (awayWins + ties * (1 - baseHomeProbability)) / simulations,
    pushProbability: 0,
  };
}

function anchoredProbability(simulatedProbability, baseProbability, maxProbability, anchorWeight) {
  const anchored =
    safeNumber(anchorWeight, 0.3) * safeNumber(baseProbability, 0.5) +
    (1 - safeNumber(anchorWeight, 0.3)) * safeNumber(simulatedProbability, 0.5);

  return clamp(anchored, 1 - maxProbability, maxProbability);
}

function compressTowardCoinFlip(probability, edgeScale) {
  const clampedProbability = clamp(safeNumber(probability, 0.5), 0.01, 0.99);
  const scaledEdge = clamp(safeNumber(edgeScale, 1), 0, 1);
  const compressed = 0.5 + (clampedProbability - 0.5) * scaledEdge;
  return clamp(compressed, 0.01, 0.99);
}

function opponentObp(gameState, opposingTeamAbbreviation) {
  return safeNumber(gameState.workbookModelData?.teamObp?.[opposingTeamAbbreviation], 0.32);
}

function opponentKRateVsHand(gameState, opposingTeamAbbreviation, pitcherHand) {
  const normalizedHand = String(pitcherHand || 'R').toUpperCase() === 'L' ? 'L' : 'R';
  return safeNumber(
    normalizedHand === 'L'
      ? gameState.workbookModelData?.teamKVsL?.[opposingTeamAbbreviation]
      : gameState.workbookModelData?.teamKVsR?.[opposingTeamAbbreviation],
    0.225
  );
}

function projectedBattersFaced(pitcher, gameState, opposingTeamAbbreviation) {
  const workbookIpBlend =
    0.45 * safeNumber(pitcher.currentIp, safeNumber(pitcher.battersFaced, 23) / 4.2) +
    0.35 * safeNumber(pitcher.ip2026, 5.5) +
    0.2 * safeNumber(pitcher.ip2025, 5.3);
  const manualBattersFaced = safeNumber(pitcher.battersFaced, workbookIpBlend * 4.2);
  const whip = safeNumber(pitcher.whip, 1.25);
  const obp = opponentObp(gameState, opposingTeamAbbreviation);

  // Treat the visible Batters Faced field as the primary live input, while
  // still leaning on workbook IP context so name-based pitcher lookups matter.
  const contextualBattersFaced = workbookIpBlend * (3 + 0.85 * whip + 1.5 * (obp - 0.32));
  const projected = 0.8 * manualBattersFaced + 0.2 * contextualBattersFaced;

  return Math.round(clamp(projected, 12, 30));
}

function projectedStrikeoutRate(pitcher, gameState, opposingTeamAbbreviation) {
  const preAdjusted = clamp(
    0.45 * safeNumber(pitcher.l30KRate, safeNumber(pitcher.k9, 8.5) / 27) +
      0.4 * safeNumber(pitcher.seasonKRate, safeNumber(pitcher.k9, 8.5) / 27) +
      0.15 * safeNumber(pitcher.lastYearKRate, safeNumber(pitcher.k9, 8.5) / 27) +
      0.35 * (safeNumber(pitcher.csw, 0.29) - 0.27),
    0.16,
    0.38
  );
  const opponentKRate = opponentKRateVsHand(gameState, opposingTeamAbbreviation, pitcher.hand);
  const obp = opponentObp(gameState, opposingTeamAbbreviation);

  return clamp(
    preAdjusted * (1 + 0.6 * (opponentKRate - 0.225)) * (1 - 0.18 * (obp - 0.32)),
    0.14,
    0.42
  );
}

function projectedStrikeouts(pitcher, gameState, opposingTeamAbbreviation) {
  const projectedBf = projectedBattersFaced(pitcher, gameState, opposingTeamAbbreviation);
  return projectedBf * projectedStrikeoutRate(pitcher, gameState, opposingTeamAbbreviation);
}

export function calculateProjections(gameState) {
  const params = gameState.workbookModelData?.params || {};
  const leagueRuns = getWorkbookParam(params, 'League_Runs_per_Team', 4.35);
  const simulationCount = Math.max(500, Math.round(getWorkbookParam(params, 'Simulation_Count', 1000)));
  const awayLineupRating = lineupOffenseRating(gameState.awayTeam.lineup);
  const homeLineupRating = lineupOffenseRating(gameState.homeTeam.lineup);

  const homeFullRaw = expectedRuns({
    lineupRating: homeLineupRating,
    teamStrengthRating: gameState.homeTeam.offenseRating,
    opposingStarter: gameState.awayTeam.probablePitcher,
    opposingStarterFip: gameState.awayTeam.probablePitcher.fip,
    opposingBullpenFip: gameState.awayTeam.bullpenFip,
    environment: gameState.environment,
    params,
    starterShare: getWorkbookParam(params, 'StarterShare_FG', 0.62),
    baseRuns: leagueRuns,
    homeFieldRuns: getWorkbookParam(params, 'HomeFieldRuns_FG', 0.12),
  });
  const awayFullRaw = expectedRuns({
    lineupRating: awayLineupRating,
    teamStrengthRating: gameState.awayTeam.offenseRating,
    opposingStarter: gameState.homeTeam.probablePitcher,
    opposingStarterFip: gameState.homeTeam.probablePitcher.fip,
    opposingBullpenFip: gameState.homeTeam.bullpenFip,
    environment: gameState.environment,
    params,
    starterShare: getWorkbookParam(params, 'StarterShare_FG', 0.62),
    baseRuns: leagueRuns,
    homeFieldRuns: 0,
  });
  const homeFirstFiveRaw = expectedRuns({
    lineupRating: homeLineupRating,
    teamStrengthRating: gameState.homeTeam.offenseRating,
    opposingStarter: gameState.awayTeam.probablePitcher,
    opposingStarterFip: gameState.awayTeam.probablePitcher.fip,
    opposingBullpenFip: gameState.awayTeam.bullpenFip,
    environment: gameState.environment,
    params,
    starterShare: getWorkbookParam(params, 'StarterShare_F5', 0.9),
    baseRuns: leagueRuns * (5 / 9),
    homeFieldRuns: getWorkbookParam(params, 'HomeFieldRuns_F5', 0.06),
    emphasizeStarter: true,
  });
  const awayFirstFiveRaw = expectedRuns({
    lineupRating: awayLineupRating,
    teamStrengthRating: gameState.awayTeam.offenseRating,
    opposingStarter: gameState.homeTeam.probablePitcher,
    opposingStarterFip: gameState.homeTeam.probablePitcher.fip,
    opposingBullpenFip: gameState.homeTeam.bullpenFip,
    environment: gameState.environment,
    params,
    starterShare: getWorkbookParam(params, 'StarterShare_F5', 0.9),
    baseRuns: leagueRuns * (5 / 9),
    homeFieldRuns: 0,
    emphasizeStarter: true,
  });

  const fullGameTotal = finalizeTotal(
    homeFullRaw + awayFullRaw,
    gameState.marketFgTotal,
    getWorkbookParam(params, 'FG_a', 0),
    getWorkbookParam(params, 'FG_b', 1),
    getWorkbookParam(params, 'FG_c', 0)
  );
  const firstFiveTotal = finalizeTotal(
    homeFirstFiveRaw + awayFirstFiveRaw,
    gameState.marketF5Total,
    getWorkbookParam(params, 'F5_a', 0),
    getWorkbookParam(params, 'F5_b', 1),
    getWorkbookParam(params, 'F5_c', 0)
  );
  const calibratedFullGameRuns = calibratedTeamRuns(homeFullRaw, awayFullRaw, fullGameTotal);
  const calibratedFirstFiveRuns = calibratedTeamRuns(homeFirstFiveRaw, awayFirstFiveRaw, firstFiveTotal);
  const fullGameSimulation = simulateMarket({
    homeRuns: calibratedFullGameRuns.runsFor,
    awayRuns: calibratedFullGameRuns.runsAgainst,
    targetTotal: fullGameTotal,
    simulations: simulationCount,
    pushOnTie: false,
    seedKey: [
      'fg',
      gameState.selectedDate,
      gameState.awayTeam.abbreviation,
      gameState.homeTeam.abbreviation,
      calibratedFullGameRuns.runsFor.toFixed(4),
      calibratedFullGameRuns.runsAgainst.toFixed(4),
      fullGameTotal.toFixed(4),
      simulationCount,
    ].join('|'),
  });
  const firstFiveSimulation = simulateMarket({
    homeRuns: calibratedFirstFiveRuns.runsFor,
    awayRuns: calibratedFirstFiveRuns.runsAgainst,
    targetTotal: firstFiveTotal,
    simulations: simulationCount,
    pushOnTie: true,
    seedKey: [
      'f5',
      gameState.selectedDate,
      gameState.awayTeam.abbreviation,
      gameState.homeTeam.abbreviation,
      calibratedFirstFiveRuns.runsFor.toFixed(4),
      calibratedFirstFiveRuns.runsAgainst.toFixed(4),
      firstFiveTotal.toFixed(4),
      simulationCount,
    ].join('|'),
  });
  const homeFullBaseProbability = winProbability(
    calibratedFullGameRuns.runsFor,
    calibratedFullGameRuns.runsAgainst
  );
  const homeFirstFiveBaseProbability = winProbability(
    calibratedFirstFiveRuns.runsFor,
    calibratedFirstFiveRuns.runsAgainst
  );
  const homeFullWinProbability = anchoredProbability(
    fullGameSimulation.homeProbability,
    homeFullBaseProbability,
    getWorkbookParam(params, 'FG_MaxWinProbability', 0.8),
    getWorkbookParam(params, 'FG_AnchorWeight', 0.32)
  );
  const adjustedHomeFullWinProbability = compressTowardCoinFlip(
    homeFullWinProbability,
    getWorkbookParam(params, 'FG_EdgeScale', 0.4)
  );
  const homeFirstFiveWinProbability = anchoredProbability(
    firstFiveSimulation.homeProbability,
    homeFirstFiveBaseProbability,
    getWorkbookParam(params, 'F5_MaxWinProbability', 0.78),
    getWorkbookParam(params, 'F5_AnchorWeight', 0.38)
  );
  const adjustedHomeFirstFiveWinProbability = compressTowardCoinFlip(
    homeFirstFiveWinProbability,
    getWorkbookParam(params, 'F5_EdgeScale', 0.3)
  );
  const awayFullWinProbability = 1 - adjustedHomeFullWinProbability;
  const awayFirstFiveWinProbability = 1 - adjustedHomeFirstFiveWinProbability;

  return {
    fullGame: {
      awayRuns: awayFullRaw,
      homeRuns: homeFullRaw,
      total: fullGameTotal,
      awayWinProbability: awayFullWinProbability,
      homeWinProbability: adjustedHomeFullWinProbability,
    },
    firstFive: {
      awayRuns: awayFirstFiveRaw,
      homeRuns: homeFirstFiveRaw,
      total: firstFiveTotal,
      awayWinProbability: awayFirstFiveWinProbability,
      homeWinProbability: adjustedHomeFirstFiveWinProbability,
    },
    simulations: {
      count: simulationCount,
      firstFivePushProbability: firstFiveSimulation.pushProbability,
    },
    offense: {
      awayLineupRating,
      homeLineupRating,
      awayEffectiveRating: effectiveOffenseRating(awayLineupRating, gameState.awayTeam.offenseRating, params),
      homeEffectiveRating: effectiveOffenseRating(homeLineupRating, gameState.homeTeam.offenseRating, params),
      awayNormalizedTeamStrength: normalizedTeamStrengthRating(gameState.awayTeam.offenseRating, params),
      homeNormalizedTeamStrength: normalizedTeamStrengthRating(gameState.homeTeam.offenseRating, params),
      awayTeamStrengthRating: safeNumber(gameState.awayTeam.offenseRating, 100),
      homeTeamStrengthRating: safeNumber(gameState.homeTeam.offenseRating, 100),
    },
    strikeouts: {
      awayStarter: projectedStrikeouts(
        gameState.awayTeam.probablePitcher,
        gameState,
        gameState.homeTeam.abbreviation
      ),
      homeStarter: projectedStrikeouts(
        gameState.homeTeam.probablePitcher,
        gameState,
        gameState.awayTeam.abbreviation
      ),
    },
  };
}

export function formatRuns(value) {
  return safeNumber(value, 0).toFixed(2);
}

export function formatDecimalOdds(probability) {
  return decimalFromProbability(probability).toFixed(3);
}
